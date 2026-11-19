import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexRuntimeRecord } from '@/codex/shared/registry'
import type { startRunnerControlServer } from './controlServer'

// Exercise the real runner closure end to end so the test can observe what
// reportSessionChildExited receives after a stop and a later child exit.

const mocks = vi.hoisted(() => ({
    controlServer: vi.fn(),
    readRuntimes: vi.fn(),
    findRuntime: vi.fn(),
    reapOrphans: vi.fn<typeof import('./orphanReap')['reapRunnerSpawnedOrphans']>(),
    kill: vi.fn(),
    sweep: vi.fn(async () => true),
    groupGone: vi.fn((_pid: number) => false),
    isProcessAlive: vi.fn<(pid: number) => boolean>(() => true),
    spawnHappyCLI: vi.fn(),
    reportChildExit: vi.fn(),
}))

vi.mock('./controlServer', () => ({ startRunnerControlServer: mocks.controlServer }))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false,
    stopRunner: async () => {},
    getInstalledCliMtimeMs: () => undefined,
    waitForRunnerHandoff: async () => false,
    cleanupRunnerState: async () => {},
}))
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    acquireRunnerLock: async () => ({}),
    releaseRunnerLock: async () => {},
}))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ machineId: 'machine' }) }))
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: (...args: unknown[]) => { if (process.env.HAPI_TEST_VERBOSE) console.log('[runner]', ...args) },
        debugLargeJson: (...args: unknown[]) => { if (process.env.HAPI_TEST_VERBOSE) console.log('[runner:json]', ...args) },
        warn: (...args: unknown[]) => { if (process.env.HAPI_TEST_VERBOSE) console.log('[runner:warn]', ...args) },
    },
}))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/agent/agentAvailability', () => ({ getAgentAvailability: () => ({ available: true }), agentUnavailableMessage: () => '' }))
vi.mock('@/modules/common/cursorModelsPrewarm', () => ({ scheduleCursorModelsPrewarm: () => {} }))
vi.mock('@/codex/shared/registry', () => ({
    readRuntimes: mocks.readRuntimes,
    findRuntime: mocks.findRuntime,
    runtimeAuthHash: () => 'test-auth',
    runtimeMayBeAlive: () => true,
}))
vi.mock('@/runner/orphanReap', () => ({
    reapRunnerSpawnedOrphans: mocks.reapOrphans,
    findStopSessionOrphanTargets: vi.fn(),
    listWindowsProcessesWithCommandLine: vi.fn(),
}))
vi.mock('@/utils/process', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/process')>(),
    isWindows: () => false,
    isProcessAlive: mocks.isProcessAlive,
    getProcessStartMarker: () => 'generation',
    // The probe reads /proc/<pid>/status on Linux: a busy shared host can have
    // an unrelated non-leader task owning PID_GONE's TID, which would classify
    // the durable record as exited (dropping it without a tombstone) before
    // the stop even runs. Keep generation probing deterministic here.
    getProcessThreadGroupId: () => null,
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
    sweepProcessGroup: mocks.sweep,
    processGroupGone: mocks.groupGone,
}))
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawnHappyCLI }))
vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getOrCreateMachine: async () => ({ id: 'machine-1' }),
            machineSyncClient: () => ({
                setRPCHandlers: vi.fn(),
                connect: vi.fn(),
                shutdown: vi.fn(),
                updateRunnerState: async () => {},
                reportSessionChildExited: mocks.reportChildExit,
            }),
        }),
    },
}))

import { configuration } from '@/configuration'
import { startRunner } from './run'
import { ExitedProcessGroups } from './exitedProcessGroups'

type RunnerHandlers = Parameters<typeof startRunnerControlServer>[0]

const PID_GONE = 5000

function makeFakeChild(pid: number): EventEmitter & { pid: number } {
    const child = new EventEmitter() as EventEmitter & { pid: number }
    child.pid = pid
    return child
}

it('evicts the oldest exited group aliases and preserves a rebound ID when cleanup finishes', () => {
    const groups = new ExitedProcessGroups(3)
    const old = { pgid: 10, startMarker: 'old' }
    const newer = { pgid: 10, startMarker: 'new' }
    groups.remember(old, ['first', 'second', 'rebound'])
    groups.remember(newer, ['rebound', 'last'])
    expect(groups.get('first')).toBeUndefined()
    expect(groups.get('second')).toBe(old)
    groups.confirm(old)
    expect(groups.get('second')).toEqual({ ...old, confirmed: true })
    expect(groups.get('rebound')).toBe(newer)
    expect(groups.get('last')).toBe(newer)
})

describe('runner intentional-stop marker cleanup', () => {
    let handlers: RunnerHandlers
    let runnerPromise: Promise<void>
    let home: string
    let captured: Error

    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), 'hapi-intentional-stop-'))
        captured = new Error('runner stopped after control handlers captured')
        handlers = {} as RunnerHandlers
        mocks.controlServer.mockImplementation(async (capturedHandlers: RunnerHandlers) => {
            handlers = capturedHandlers
            return { port: 0, stop: async () => {} }
        })
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw captured })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        vi.stubEnv('HAPI_RUNNER_HEARTBEAT_INTERVAL', '3600000')
        vi.stubEnv('HAPI_DISABLE_VERSION_HANDOFF', '1')
        Object.defineProperty(configuration, 'runnerStateFile', { value: join(home, 'runner.json'), configurable: true })
        // A runner restart recovers this durable record: PID_GONE once hosted
        // 'sess-gone' and the generation probe verifies it as alive.
        writeFileSync(`${configuration.runnerStateFile}.resume-processes.json`, JSON.stringify([
            { requestedSessionId: 'sess-gone', pid: PID_GONE, processStartMarker: 'generation' },
        ]))
        runnerPromise = startRunner()
        await vi.waitFor(() => expect(handlers.stopSession).toBeTypeOf('function'))
    })

    afterAll(async () => {
        handlers.requestShutdown()
        await expect(runnerPromise).rejects.toBe(captured)
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        rmSync(home, { recursive: true, force: true })
    })

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.readRuntimes.mockResolvedValue([])
        mocks.findRuntime.mockResolvedValue(undefined)
        mocks.reapOrphans.mockResolvedValue(null)
        mocks.kill.mockResolvedValue(true)
        mocks.sweep.mockResolvedValue(true)
        mocks.groupGone.mockReturnValue(false)
        mocks.isProcessAlive.mockImplementation(() => true)
        mocks.spawnHappyCLI.mockImplementation(() => { throw new Error('no child queued for spawn') })
    })

    // The spawn registers its child asynchronously (workspace validation runs
    // first), so the confirming webhook is retried until the awaiter resolves.
    async function confirmSpawn(spawnPromise: Promise<unknown>, sessionId: string, pid: number): Promise<void> {
        const metadata = {
            path: home,
            host: 'localhost',
            machineId: 'machine',
            hostPid: pid,
            startedBy: 'runner',
            lifecycleState: 'running',
        }
        let settled = false
        void spawnPromise.then(() => { settled = true }, () => { settled = true })
        const deadline = Date.now() + 4_000
        while (!settled && Date.now() < deadline) {
            handlers.onHappySessionWebhook(sessionId, metadata as never)
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        if (!settled) throw new Error(`Spawn ${sessionId} was not confirmed by webhook`)
    }

    it('reports a reused pid unexpected exit after a stop that returned already_gone', async () => {
        // The process is already dead when the stop runs: the runner reports
        // already_gone without any exit event for it.
        mocks.isProcessAlive.mockImplementation((pid: number) => pid !== PID_GONE)
        await expect(handlers.stopSession('sess-gone')).resolves.toBe('already_gone')

        // A later spawn reuses the OS pid for a new session and dies on its own.
        const reusedChild = makeFakeChild(PID_GONE)
        mocks.spawnHappyCLI.mockImplementation(() => reusedChild)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'sess-new' })
        await confirmSpawn(spawnPromise, 'sess-new', PID_GONE)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'sess-new' })

        reusedChild.emit('exit', 1, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalledTimes(1))
        expect(mocks.reportChildExit).toHaveBeenCalledWith(
            expect.objectContaining({ sid: 'sess-new', pid: PID_GONE })
        )
    })

    it('sweeps the recorded process group of a wrapper that exited on its own', async () => {
        const child = makeFakeChild(6300)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'sess-exited' })
        await confirmSpawn(spawnPromise, 'sess-exited', 6300)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'sess-exited' })

        mocks.isProcessAlive.mockImplementation((pid: number) => pid !== 6300)
        child.emit('exit', 1, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalled())

        mocks.sweep.mockResolvedValueOnce(false)
        await expect(handlers.stopSession('sess-exited', { requireProcessGroupCleanup: true })).resolves.toBe('still_alive')
        expect(mocks.sweep).toHaveBeenCalledWith(6300, expect.objectContaining({ expectedStartMarker: 'generation' }))

        await expect(handlers.stopSession('sess-exited', { requireProcessGroupCleanup: true })).resolves.toBe('already_gone')
        expect(mocks.sweep).toHaveBeenCalledTimes(2)

        await expect(handlers.stopSession('sess-exited', { requireProcessGroupCleanup: true })).resolves.toBe('already_gone')
        expect(mocks.sweep).toHaveBeenCalledTimes(2)
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it.each([true, false])('never sweeps a reused group observed empty (empty at exit: %s)', async emptyAtExit => {
        const pid = emptyAtExit ? 6450 : 6451
        const id = `reused-group-${pid}`
        const child = makeFakeChild(pid)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawn = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: id })
        await confirmSpawn(spawn, id, pid)
        await expect(spawn).resolves.toEqual({ type: 'success', sessionId: id })
        mocks.groupGone.mockImplementation(candidate => candidate === pid && emptyAtExit)
        mocks.isProcessAlive.mockImplementation(candidate => candidate !== pid)
        child.emit('exit', 0, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalled())
        if (!emptyAtExit) {
            mocks.sweep.mockResolvedValueOnce(false)
            await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('still_alive')
            expect(mocks.sweep).toHaveBeenCalledTimes(1)
            mocks.sweep.mockClear()
            mocks.groupGone.mockImplementation(candidate => candidate === pid)
            await handlers.stopSession('unrelated-session')
        }
        mocks.groupGone.mockReturnValue(false)
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('already_gone')
        expect(mocks.sweep).not.toHaveBeenCalled()
    })

    it('acknowledges a repeated stop after the first successful sweep reply is lost', async () => {
        const id = 'lost-stop-ack'
        const child = makeFakeChild(6499)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawned = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: id })
        await confirmSpawn(spawned, id, 6499)
        const opts = { requireProcessGroupCleanup: true }
        await expect(handlers.stopSession(id, opts)).resolves.toBe('stopped')
        mocks.isProcessAlive.mockImplementation(pid => pid !== 6499)
        child.emit('exit', 0, null)
        await expect(handlers.stopSession(id, opts)).resolves.toBe('already_gone')
        expect(mocks.sweep).toHaveBeenCalledTimes(1)
    })

    it('archive of an exited wrapper leaves its recorded process group alone', async () => {
        const child = makeFakeChild(6400)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'sess-archive' })
        await confirmSpawn(spawnPromise, 'sess-archive', 6400)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'sess-archive' })

        mocks.isProcessAlive.mockImplementation((pid: number) => pid !== 6400)
        child.emit('exit', 1, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalled())

        await expect(handlers.stopSession('sess-archive')).resolves.toBe('already_gone')
        expect(mocks.sweep).not.toHaveBeenCalled()
    })

    it('sweeps only the current group after a respawn under the same session ID', async () => {
        const id = 'same-id-respawn'
        for (const pid of [6600, 6601]) {
            const child = makeFakeChild(pid)
            mocks.spawnHappyCLI.mockImplementation(() => child)
            const spawn = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: id })
            await confirmSpawn(spawn, id, pid)
            await expect(spawn).resolves.toEqual({ type: 'success', sessionId: id })
            if (pid === 6600) {
                mocks.isProcessAlive.mockImplementation(candidate => candidate !== pid)
                child.emit('exit', 1, null)
                await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalled())
            }
        }
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('stopped')
        expect(mocks.sweep).toHaveBeenCalledTimes(1)
        expect(mocks.sweep).toHaveBeenCalledWith(6601, expect.any(Object))
    })

    it('retains a tracked group when its child exits during tree termination and the sweep fails', async () => {
        const id = 'retry-tracked'
        const child = makeFakeChild(6700)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawn = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: id })
        await confirmSpawn(spawn, id, 6700)
        await expect(spawn).resolves.toEqual({ type: 'success', sessionId: id })
        mocks.kill.mockImplementationOnce(async () => {
            mocks.isProcessAlive.mockImplementation(pid => pid !== 6700)
            child.emit('exit', 0, null)
            return true
        })
        mocks.sweep.mockResolvedValueOnce(false)
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('still_alive')
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('already_gone')
        expect(mocks.sweep).toHaveBeenCalledTimes(2)
        expect(mocks.sweep).toHaveBeenLastCalledWith(6700, { expectedStartMarker: 'generation', leaderExited: true })
    })

    it('archive kills the tracked tree without signalling the whole process group', async () => {
        const child = makeFakeChild(6500)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'sess-killed' })
        await confirmSpawn(spawnPromise, 'sess-killed', 6500)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'sess-killed' })

        await expect(handlers.stopSession('sess-killed')).resolves.toBe('stopped')
        expect(mocks.sweep).not.toHaveBeenCalled()
        expect(mocks.kill).toHaveBeenCalled()
        mocks.isProcessAlive.mockImplementation((pid: number) => pid !== 6500)
        child.emit('exit', 0, null)
        await Promise.resolve()

        await expect(handlers.stopSession('sess-killed')).resolves.toBe('already_gone')
        expect(mocks.sweep).not.toHaveBeenCalled()
    })

    it('retries an adopted wrapper group after its verified leader dies during stop', async () => {
        const id = 'adopted-retry'
        const pid = 6800
        handlers.onHappySessionWebhook(id, {
            hostPid: pid, hostStartMarker: 'generation', startedBy: 'runner', flavor: 'claude',
            lifecycleState: 'running', path: home, host: 'localhost'
        } as never)
        mocks.kill.mockImplementationOnce(async () => {
            mocks.isProcessAlive.mockImplementation(candidate => candidate !== pid)
            return true
        })
        mocks.sweep.mockResolvedValueOnce(false)
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('still_alive')
        await expect(handlers.stopSession(id, { requireProcessGroupCleanup: true })).resolves.toBe('already_gone')
        expect(mocks.sweep).toHaveBeenCalledTimes(2)
        await expect(handlers.stopSession(id)).resolves.toBe('already_gone')
    })

    it('requires group evidence after an argv-only orphan reap', async () => {
        mocks.reapOrphans.mockResolvedValue('stopped')
        await expect(handlers.stopSession('orphan-only', { requireProcessGroupCleanup: true })).resolves.toBe('unknown')
        await expect(handlers.stopSession('orphan-only')).resolves.toBe('stopped')
    })

    it('still suppresses the exit of a child the stop killed intentionally', async () => {
        const child = makeFakeChild(6100)
        mocks.spawnHappyCLI.mockImplementation(() => child)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'sess-live' })
        await confirmSpawn(spawnPromise, 'sess-live', 6100)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'sess-live' })

        await expect(handlers.stopSession('sess-live')).resolves.toBe('stopped')
        expect(mocks.kill).toHaveBeenCalled()

        // The killed child's own exit event must not reach the hub as an
        // unexpected death: the stop flow already ends the session.
        child.emit('exit', 0, null)
        await Promise.resolve()
        expect(mocks.reportChildExit).not.toHaveBeenCalled()
    })

    it('releases the intentional marker when a stop preserves the shared wrapper for siblings', async () => {
        const wrapper = makeFakeChild(6200)
        mocks.spawnHappyCLI.mockImplementation(() => wrapper)
        const spawnPromise = handlers.spawnSession({ directory: home, agent: 'claude', existingSessionId: 'wrapper-main' })
        await confirmSpawn(spawnPromise, 'wrapper-main', 6200)
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'wrapper-main' })
        for (const root of ['root-a', 'sibling-b']) {
            handlers.onHappySessionWebhook(root, {
                path: home,
                host: 'localhost',
                machineId: 'machine',
                hostPid: 6200,
                startedBy: 'runner',
                lifecycleState: 'running',
                capabilities: { concurrentClients: true },
            } as never)
        }

        // Archiving the primary root keeps the wrapper alive for the sibling.
        mocks.readRuntimes.mockResolvedValue([{
            id: 'runtime', pid: 6200, marker: 'generation', endpoint: 'unused',
            command: 'codex', args: [], codexHome: home,
            hub: configuration.apiUrl, authHash: 'test-auth',
            sessions: {
                'root-a': { threadId: 'a', namespace: 'test', active: false },
                'sibling-b': { threadId: 'b', namespace: 'test', active: true },
            },
        }])
        await expect(handlers.stopSession('root-a', { requireProcessGroupCleanup: true })).resolves.toBe('stopped')
        expect(mocks.kill).not.toHaveBeenCalled()

        // The surviving wrapper later crashes on its own: the sibling's death
        // must still be reported, not suppressed by the root's stop marker.
        wrapper.emit('exit', 1, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalledWith(
            expect.objectContaining({ sid: 'sibling-b', pid: 6200 })
        ))
    })
})
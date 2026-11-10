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
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
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

type RunnerHandlers = Parameters<typeof startRunnerControlServer>[0]

const PID_GONE = 5000

function makeFakeChild(pid: number): EventEmitter & { pid: number } {
    const child = new EventEmitter() as EventEmitter & { pid: number }
    child.pid = pid
    return child
}

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
        await expect(handlers.stopSession('root-a')).resolves.toBe('stopped')
        expect(mocks.kill).not.toHaveBeenCalled()

        // The surviving wrapper later crashes on its own: the sibling's death
        // must still be reported, not suppressed by the root's stop marker.
        wrapper.emit('exit', 1, null)
        await vi.waitFor(() => expect(mocks.reportChildExit).toHaveBeenCalledWith(
            expect.objectContaining({ sid: 'sibling-b', pid: 6200 })
        ))
    })
})
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Metadata } from '@/api/types'
import type { startRunnerControlServer } from './controlServer'
import type { StopSessionOptions } from './stopSessionRequests'

const mocks = vi.hoisted(() => ({
    controlServer: vi.fn(),
    reapOrphans: vi.fn<typeof import('./orphanReap')['reapRunnerSpawnedOrphans']>(),
    kill: vi.fn(),
    prepare: vi.fn(),
    confirm: vi.fn(),
    marker: vi.fn(() => 'generation'),
    spawnHappyCLI: vi.fn(),
    collectTree: vi.fn(() => [4242]),
    now: vi.fn(() => 1000),
}))

vi.mock('./controlServer', () => ({ startRunnerControlServer: mocks.controlServer }))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false,
    stopRunner: async () => {},
}))
vi.mock('@/api/api', () => ({
    ApiClient: { create: async () => ({ prepareOpenCodeSessionStop: mocks.prepare, confirmRecoveryStop: mocks.confirm }) },
}))
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    acquireRunnerLock: async () => ({}),
}))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ machineId: 'machine' }) }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }))
vi.mock('@/utils/time', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/time')>(),
    monotonicTimeMs: () => mocks.now(),
}))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/codex/shared/registry', () => ({
    readRuntimes: async () => [],
    findRuntime: async () => undefined,
    runtimeAuthHash: () => 'test-auth',
    runtimeMayBeAlive: () => true,
}))
vi.mock('@/runner/orphanReap', () => ({
    reapRunnerSpawnedOrphans: mocks.reapOrphans,
    findStopSessionOrphanTargets: vi.fn(),
}))
vi.mock('@/utils/process', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/process')>(),
    isWindows: () => false,
    isProcessAlive: () => true,
    getProcessStartMarker: () => mocks.marker(),
    collectProcessTree: mocks.collectTree,
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
}))
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawnHappyCLI }))

import { configuration } from '@/configuration'
import { startRunner } from './run'

/**
 * A child adopted after a runner restart has no exit event. Once StopSession
 * proved its process tree gone, the next spawn for the same HAPI id must start
 * a new child instead of answering with the dead child's recovered result.
 */
describe('runner stop of an adopted child', () => {
    type Handlers = Parameters<typeof startRunnerControlServer>[0]
    let handlers: Handlers
    let home: string
    const respawn = { directory: '/tmp', existingSessionId: 'adopted', validateDirectory: async () => false }
    const stop = (opts?: StopSessionOptions, id = 'adopted') =>
        (handlers.stopSession as (id: string, opts?: StopSessionOptions) => ReturnType<Handlers['stopSession']>)(id, opts)

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.collectTree.mockReset().mockReturnValue([4242])
        mocks.now.mockReset().mockReturnValue(1000)
        mocks.kill.mockResolvedValue(true)
        mocks.reapOrphans.mockResolvedValue(null)
        mocks.prepare.mockResolvedValue(undefined)
        mocks.confirm.mockResolvedValue(true)
        mocks.marker.mockReturnValue('generation')
        mocks.spawnHappyCLI.mockImplementation(() => { throw new Error('no child queued for spawn') })
        home = mkdtempSync(join(tmpdir(), 'hapi-stop-release-'))
        const originalStateFile = configuration.runnerStateFile
        const captured = new Error('control handlers captured before runner networking')
        mocks.controlServer.mockImplementation(async (captureHandlers: Handlers) => {
            handlers = captureHandlers
            throw captured
        })
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw captured })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        const stateFile = join(home, 'runner.json')
        writeFileSync(`${stateFile}.resume-processes.json`, JSON.stringify([{
            requestedSessionId: 'adopted', confirmedSessionId: 'adopted',
            pid: 4242, processStartMarker: 'generation', flavor: 'claude',
        }]))
        Object.defineProperty(configuration, 'runnerStateFile', { value: stateFile, configurable: true })
        try {
            await expect(startRunner()).rejects.toBe(captured)
        } finally {
            Object.defineProperty(configuration, 'runnerStateFile', { value: originalStateFile, configurable: true })
            vi.restoreAllMocks()
            vi.unstubAllEnvs()
        }
        handlers.onHappySessionWebhook('adopted', {
            path: '/tmp', host: 'localhost', flavor: 'claude', startedBy: 'runner',
            hostPid: 4242, hostStartMarker: 'generation',
        } as Metadata)
    })

    afterEach(() => rmSync(home, { recursive: true, force: true }))

    it('marks a spawn answered by the running child as reused', async () => {
        await expect(handlers.spawnSession(respawn)).resolves.toEqual({ type: 'success', sessionId: 'adopted', reusedChild: true })
    })

    it('starts a new spawn for the id right after StopSession confirmed the stop', async () => {
        await expect(stop()).resolves.toBe('stopped')
        expect(mocks.kill).toHaveBeenCalled()

        const after = await handlers.spawnSession(respawn)
        expect(after.type).toBe('error')
    })

    it('holds a same-id spawn until the stop finished its orphan sweep', async () => {
        let finishSweep!: () => void
        let sweepStarted!: () => void
        const started = new Promise<void>(resolve => { sweepStarted = resolve })
        mocks.reapOrphans.mockImplementation(() => new Promise(resolve => {
            sweepStarted()
            finishSweep = () => resolve(null)
        }))
        const stopping = stop()
        await started

        // A child started now would match the sweep's argv scan.
        let settled = false
        const spawning = handlers.spawnSession(respawn).finally(() => { settled = true })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(settled).toBe(false)

        finishSweep()
        await expect(stopping).resolves.toBe('stopped')
        expect((await spawning).type).toBe('error')
    })

    it('signals a recovery target only after the hub confirms that exact request and process', async () => {
        mocks.confirm.mockResolvedValueOnce(false)
        await expect(stop({ recovery: { requestId: 'r1', pid: 4242 } })).resolves.toBe('still_alive')
        expect(mocks.confirm).toHaveBeenCalledWith('adopted', 'machine', 4242, 'r1')
        expect(mocks.kill).not.toHaveBeenCalled()

        // Another process for the id is never signalled, and the hub is not asked.
        mocks.confirm.mockClear()
        await expect(stop({ recovery: { requestId: 'r2', pid: 9999 } })).resolves.toBe('still_alive')
        expect(mocks.confirm).not.toHaveBeenCalled()
        expect(mocks.kill).not.toHaveBeenCalled()

        await expect(stop({ recovery: { requestId: 'r3', pid: 4242 } })).resolves.toBe('stopped')
        expect(mocks.confirm).toHaveBeenCalledWith('adopted', 'machine', 4242, 'r3')
        expect(mocks.prepare).not.toHaveBeenCalled()
        expect(mocks.kill).toHaveBeenCalledTimes(1)
        // No argv sweep: nothing beyond the named process is signalled.
        expect(mocks.reapOrphans).not.toHaveBeenCalled()
    })

    it('declines a recovery stop on Windows without confirming or signalling', async () => {
        const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        try {
            await expect(stop({ recovery: { requestId: 'r-win', pid: 4242 } })).resolves.toBe('still_alive')
            expect(mocks.confirm).not.toHaveBeenCalled()
            expect(mocks.prepare).not.toHaveBeenCalled()
            expect(mocks.kill).not.toHaveBeenCalled()
        } finally {
            if (originalPlatformDescriptor) {
                Object.defineProperty(process, 'platform', originalPlatformDescriptor)
            }
        }
    })

    it('declines a recovery stop with no tracked child instead of sweeping argv for a same-id MCP bridge', async () => {
        // No tracked or persisted process for this HAPI id: the general argv
        // sweep would match an MCP bridge stamped with the same session id and
        // signal it without the hub confirming the requested pid.
        await expect(stop({ recovery: { requestId: 'r-miss', pid: 7777 } }, 'untracked')).resolves.toBe('still_alive')
        expect(mocks.reapOrphans).not.toHaveBeenCalled()
        expect(mocks.kill).not.toHaveBeenCalled()
        expect(mocks.confirm).not.toHaveBeenCalled()
    })

    it('declines a recovery stop when the tracked child exits during confirmation and its pid is reused', async () => {
        const child = new EventEmitter() as EventEmitter & { pid: number }
        child.pid = 4242
        mocks.spawnHappyCLI.mockReturnValue(child)
        const spawnPromise = handlers.spawnSession({
            directory: '/tmp',
            existingSessionId: 'race',
            validateDirectory: async () => true,
        })
        let settled = false
        void spawnPromise.then(() => { settled = true }, () => { settled = true })
        const deadline = Date.now() + 2_000
        while (!settled && Date.now() < deadline) {
            handlers.onHappySessionWebhook('race', {
                path: '/tmp', host: 'localhost', flavor: 'claude', startedBy: 'runner',
                hostPid: 4242, hostStartMarker: 'generation',
            } as Metadata)
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'race' })
        mocks.kill.mockClear()

        mocks.confirm.mockImplementation(async () => {
            // The exit drops the persisted marker; the OS hands the same pid
            // to an unrelated process before confirmation returns.
            child.emit('exit', 0, null)
            mocks.marker.mockReturnValue('recycled-generation')
            return true
        })

        await expect(stop({ recovery: { requestId: 'r-race', pid: 4242 } }, 'race')).resolves.toBe('unknown')
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('collects the recovery tree before the hub is asked and signals with that tree', async () => {
        const order: string[] = []
        mocks.collectTree.mockImplementation(() => { order.push('scan'); return [4242] })
        mocks.confirm.mockImplementation(async () => { order.push('confirm'); return true })

        await expect(stop({ recovery: { requestId: 'r-order', pid: 4242 } })).resolves.toBe('stopped')

        expect(order).toEqual(['scan', 'confirm'])
        expect(mocks.kill).toHaveBeenCalledWith(4242, false, expect.any(Function), undefined, undefined, [4242])
    })

    it('refuses a recovery signal after the approval signal deadline elapses', async () => {
        mocks.now
            .mockReturnValueOnce(1000)
            .mockReturnValue(1000 + 5_000)
        mocks.confirm.mockResolvedValue(true)

        await expect(stop({ recovery: { requestId: 'r-stale', pid: 4242 } })).resolves.toBe('still_alive')

        expect(mocks.kill).not.toHaveBeenCalled()
    })
})

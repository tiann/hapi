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
    getProcessStartMarker: () => 'generation',
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
}))

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
    const stop = (opts?: StopSessionOptions) =>
        (handlers.stopSession as (id: string, opts?: StopSessionOptions) => ReturnType<Handlers['stopSession']>)('adopted', opts)

    beforeEach(async () => {
        vi.clearAllMocks()
        mocks.kill.mockResolvedValue(true)
        mocks.reapOrphans.mockResolvedValue(null)
        mocks.prepare.mockResolvedValue(undefined)
        mocks.confirm.mockResolvedValue(true)
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
})

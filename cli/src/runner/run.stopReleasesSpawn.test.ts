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
}))

vi.mock('./controlServer', () => ({ startRunnerControlServer: mocks.controlServer }))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false,
    stopRunner: async () => {},
}))
vi.mock('@/api/api', () => ({
    ApiClient: { create: async () => ({ prepareOpenCodeSessionStop: mocks.prepare }) },
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

    it('keeps the dedupe until the orphan sweep finished', async () => {
        let finishSweep!: () => void
        let sweepStarted!: () => void
        const started = new Promise<void>(resolve => { sweepStarted = resolve })
        mocks.reapOrphans.mockImplementation(() => new Promise(resolve => {
            sweepStarted()
            finishSweep = () => resolve(null)
        }))
        const stopping = stop()
        await started

        // A same-id spawn during the sweep must not start a child the sweep could match.
        await expect(handlers.spawnSession(respawn)).resolves.toEqual({ type: 'success', sessionId: 'adopted', reusedChild: true })

        finishSweep()
        await expect(stopping).resolves.toBe('stopped')
        expect((await handlers.spawnSession(respawn)).type).toBe('error')
    })

    it('asks the hub before signalling any flavor only when the stop must confirm reachability', async () => {
        mocks.prepare.mockRejectedValueOnce(new Error('Session wrapper reconnected; recovery stop cancelled'))
        await expect(stop({ confirmUnreachable: true })).resolves.toBe('still_alive')
        expect(mocks.prepare).toHaveBeenCalledWith('adopted', 'machine', 4242, 'generation')
        expect(mocks.kill).not.toHaveBeenCalled()

        mocks.prepare.mockClear()
        await expect(stop()).resolves.toBe('stopped')
        expect(mocks.prepare).not.toHaveBeenCalled()
        expect(mocks.kill).toHaveBeenCalled()
    })
})

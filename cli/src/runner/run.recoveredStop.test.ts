import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { startRunnerControlServer } from './controlServer'

const mocks = vi.hoisted(() => ({
    controlServer: vi.fn(),
    readRuntimes: vi.fn(),
    findRuntime: vi.fn(),
    reapOrphans: vi.fn<typeof import('./orphanReap')['reapRunnerSpawnedOrphans']>(),
    kill: vi.fn(),
    prepare: vi.fn(),
    alive: vi.fn(() => true),
    marker: vi.fn(() => 'generation'),
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
    readRuntimes: mocks.readRuntimes,
    findRuntime: mocks.findRuntime,
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
    isProcessAlive: () => mocks.alive(),
    getProcessStartMarker: () => mocks.marker(),
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
}))

import { configuration } from '@/configuration'
import { startRunner } from './run'

describe('runner stop of recovered persisted sessions while the Hub is unavailable', () => {
    let stopSession: Parameters<typeof startRunnerControlServer>[0]['stopSession']
    let home: string

    const startWith = async (records: unknown[]) => {
        home = mkdtempSync(join(tmpdir(), 'hapi-stop-recovered-'))
        const originalStateFile = configuration.runnerStateFile
        const captured = new Error('control handlers captured before runner networking')
        mocks.controlServer.mockImplementation(async handlers => {
            stopSession = handlers.stopSession
            throw captured
        })
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw captured })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        const stateFile = join(home, 'runner.json')
        writeFileSync(`${stateFile}.resume-processes.json`, JSON.stringify(records))
        Object.defineProperty(configuration, 'runnerStateFile', { value: stateFile, configurable: true })
        try {
            await expect(startRunner()).rejects.toBe(captured)
        } finally {
            Object.defineProperty(configuration, 'runnerStateFile', { value: originalStateFile, configurable: true })
            vi.restoreAllMocks()
            vi.unstubAllEnvs()
        }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.alive.mockReturnValue(true)
        mocks.marker.mockReturnValue('generation')
        mocks.readRuntimes.mockResolvedValue([])
        mocks.findRuntime.mockResolvedValue(undefined)
        mocks.reapOrphans.mockResolvedValue(null)
        mocks.prepare.mockRejectedValue(new Error('hub unavailable'))
        mocks.kill.mockResolvedValue(true)
    })

    afterEach(() => rmSync(home, { recursive: true, force: true }))

    it('still kills a recovered non-OpenCode process tree without Hub preparation', async () => {
        await startWith([{
            requestedSessionId: 'claude-session', confirmedSessionId: 'claude-session',
            pid: 4242, processStartMarker: 'generation', flavor: 'claude',
        }])
        await expect(stopSession('claude-session')).resolves.toBe('stopped')
        expect(mocks.prepare).not.toHaveBeenCalled()
        expect(mocks.kill).toHaveBeenCalled()
    })

    it('keeps the mandatory Hub preparation for a recovered OpenCode process', async () => {
        await startWith([{
            requestedSessionId: 'opencode-session', confirmedSessionId: 'opencode-session',
            pid: 4242, processStartMarker: 'generation', flavor: 'opencode',
        }])
        await expect(stopSession('opencode-session')).resolves.toBe('still_alive')
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('keeps the mandatory Hub preparation when the recovered flavor is unknown', async () => {
        await startWith([{
            requestedSessionId: 'legacy-session', confirmedSessionId: 'legacy-session',
            pid: 4242, processStartMarker: 'generation',
        }])
        await expect(stopSession('legacy-session')).resolves.toBe('still_alive')
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('reports already_gone when a recovered OpenCode process exits during Hub preparation', async () => {
        await startWith([{
            requestedSessionId: 'opencode-session', confirmedSessionId: 'opencode-session',
            pid: 4242, processStartMarker: 'generation', flavor: 'opencode',
        }])
        mocks.prepare.mockImplementation(async () => {
            // The process dies inside the preparation round-trip window; the
            // Hub grants no lease (undefined expiry).
            mocks.alive.mockReturnValue(false)
            return undefined as unknown as boolean
        })
        await expect(stopSession('opencode-session')).resolves.toBe('already_gone')
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('refuses to signal a recycled PID after Hub preparation', async () => {
        await startWith([{
            requestedSessionId: 'opencode-session', confirmedSessionId: 'opencode-session',
            pid: 4242, processStartMarker: 'generation', flavor: 'opencode',
        }])
        mocks.prepare.mockImplementation(async () => {
            // The Hub grants no lease; the OS recycles the PID right after
            // preparation's own verification, before the kill signal.
            mocks.marker.mockReturnValueOnce('generation').mockReturnValue('recycled-generation')
            return undefined as unknown as boolean
        })
        await expect(stopSession('opencode-session')).resolves.toBe('unknown')
        expect(mocks.kill).not.toHaveBeenCalled()
    })
})

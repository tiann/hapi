import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexRuntimeRecord } from '@/codex/shared/registry'
import type { startRunnerControlServer } from './controlServer'

const mocks = vi.hoisted(() => ({
    controlServer: vi.fn(),
    readRuntimes: vi.fn(),
    findRuntime: vi.fn(),
    reapOrphans: vi.fn<typeof import('./orphanReap')['reapRunnerSpawnedOrphans']>(),
    kill: vi.fn(),
}))

vi.mock('./controlServer', () => ({ startRunnerControlServer: mocks.controlServer }))
vi.mock('./controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => false,
    stopRunner: async () => {},
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
    isProcessAlive: () => true,
    getProcessStartMarker: () => 'generation',
    killProcess: mocks.kill,
    killProcessTreeByPid: mocks.kill,
    killProcessByChildProcess: mocks.kill,
}))

import { configuration } from '@/configuration'
import { startRunner } from './run'

describe('runner stop confirmation after shared Codex tracking loss', () => {
    let stopSession: Parameters<typeof startRunnerControlServer>[0]['stopSession']
    let record: CodexRuntimeRecord
    let home: string

    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), 'hapi-stop-confirm-'))
        const originalStateFile = configuration.runnerStateFile
        const captured = new Error('control handlers captured before runner networking')
        mocks.controlServer.mockImplementation(async handlers => {
            stopSession = handlers.stopSession
            throw captured
        })
        // Stop startup at control-server registration. Exercise its real closure
        // without installing process handlers, taking a lock, or connecting a hub.
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw captured })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        Object.defineProperty(configuration, 'runnerStateFile', { value: join(home, 'runner.json'), configurable: true })
        try {
            await expect(startRunner()).rejects.toBe(captured)
            expect(stopSession!).toBeTypeOf('function')
        } finally {
            Object.defineProperty(configuration, 'runnerStateFile', { value: originalStateFile, configurable: true })
            vi.restoreAllMocks()
            vi.unstubAllEnvs()
        }
    })

    afterAll(() => rmSync(home, { recursive: true, force: true }))

    beforeEach(() => {
        vi.clearAllMocks()
        record = {
            id: 'runtime', pid: 42, marker: 'generation', endpoint: 'unused',
            command: 'codex', args: [], codexHome: home,
            hub: configuration.apiUrl, authHash: 'test-auth',
            sessions: { target: { threadId: 'thread', namespace: 'test', active: false } },
        }
        mocks.readRuntimes.mockResolvedValue([record])
        mocks.findRuntime.mockResolvedValue(undefined)
        mocks.reapOrphans.mockResolvedValue(null)
    })

    it('confirms the last inactive root without tracking or an exit tombstone', async () => {
        await expect(stopSession('target')).resolves.toBe('stopped')
        expect(mocks.reapOrphans).toHaveBeenCalledWith('target', expect.any(Object))
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('also confirms an inactive root while preserving a live sibling', async () => {
        record.sessions.sibling = { threadId: 'other', namespace: 'test', active: true }
        await expect(stopSession('target')).resolves.toBe('stopped')
        expect(mocks.kill).not.toHaveBeenCalled()
    })

    it('does not treat an active root as stopped when runtime control is unavailable', async () => {
        record.sessions.target.active = true
        await expect(stopSession('target')).resolves.toBe('still_alive')
        expect(mocks.reapOrphans).not.toHaveBeenCalled()
    })

    it('does not infer success from an absent binding', async () => {
        record.sessions = {}
        await expect(stopSession('target')).resolves.toBe('unknown')
    })

    it('still refuses when the orphan sweep cannot establish exit', async () => {
        mocks.reapOrphans.mockResolvedValue('still_alive')
        await expect(stopSession('target')).resolves.toBe('still_alive')
    })

    it('does not use a binding from another hub or auth namespace', async () => {
        record.hub = 'another-hub'
        await expect(stopSession('target')).resolves.toBe('unknown')
        record.hub = configuration.apiUrl
        record.authHash = 'another-auth'
        await expect(stopSession('target')).resolves.toBe('unknown')
    })

    it('keeps raw PID confirmation fail-closed without a start marker', async () => {
        await expect(stopSession('PID-42')).resolves.toBe('unknown')
        expect(mocks.kill).not.toHaveBeenCalled()
    })
})

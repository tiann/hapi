import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import type { startRunnerControlServer } from './controlServer'

// Regression test for the review finding "Refresh liveness while startup
// registration is retrying": the in-process heartbeat interval is armed only
// AFTER `hub register` (getOrCreateMachine) succeeds, so a supervised runner
// retrying registration for longer than the watchdog's stale window would be
// kill -9'd by the out-of-process watchdog while perfectly healthy. Every
// retry iteration must refresh the heartbeat.

const mocks = vi.hoisted(() => ({
    controlServer: vi.fn(),
    touchRunnerHeartbeat: vi.fn(),
    ensureWatchdogInstalled: vi.fn(async () => 'installed'),
    clearRunnerHeartbeat: vi.fn(),
    getOrCreateMachine: vi.fn(),
    machineSyncStarted: false,
}))

vi.mock('./watchdog', () => ({
    touchRunnerHeartbeat: mocks.touchRunnerHeartbeat,
    ensureWatchdogInstalled: mocks.ensureWatchdogInstalled,
    clearRunnerHeartbeat: mocks.clearRunnerHeartbeat,
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
        debug: () => {},
        debugLargeJson: () => {},
        warn: () => {},
    },
}))
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }))
vi.mock('@/agent/agentAvailability', () => ({ getAgentAvailability: () => ({ available: true }), agentUnavailableMessage: () => '' }))
vi.mock('@/modules/common/cursorModelsPrewarm', () => ({ scheduleCursorModelsPrewarm: () => {} }))
vi.mock('@/codex/shared/registry', () => ({
    readRuntimes: vi.fn(async () => []),
    findRuntime: vi.fn(async () => undefined),
    runtimeAuthHash: () => 'test-auth',
    runtimeMayBeAlive: () => true,
}))
vi.mock('@/runner/orphanReap', () => ({
    reapRunnerSpawnedOrphans: vi.fn(async () => null),
    findStopSessionOrphanTargets: vi.fn(),
    listWindowsProcessesWithCommandLine: vi.fn(),
}))
vi.mock('@/utils/process', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/process')>(),
    isWindows: () => false,
    isProcessAlive: () => true,
    getProcessStartMarker: () => 'generation',
    killProcess: vi.fn(async () => true),
    killProcessTreeByPid: vi.fn(async () => true),
    killProcessByChildProcess: vi.fn(async () => true),
}))
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: vi.fn() }))
vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getOrCreateMachine: mocks.getOrCreateMachine,
            machineSyncClient: () => {
                mocks.machineSyncStarted = true
                return {
                    setRPCHandlers: vi.fn(),
                    connect: vi.fn(),
                    shutdown: vi.fn(),
                    updateRunnerState: async () => {},
                    reportSessionChildExited: vi.fn(),
                }
            },
        }),
    },
}))

import { configuration } from '@/configuration'
import { startRunner } from './run'

type RunnerHandlers = Parameters<typeof startRunnerControlServer>[0]

function retryableConnectionError(): Error {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3006') as Error & { code: string }
    error.code = 'ECONNREFUSED'
    return error
}

describe('runner watchdog heartbeat during startup registration retries', () => {
    let handlers: RunnerHandlers
    let runnerPromise: Promise<void>
    let home: string
    let captured: Error

    beforeAll(async () => {
        home = mkdtempSync(join(tmpdir(), 'hapi-registration-heartbeat-'))
        captured = new Error('runner stopped after control handlers captured')
        handlers = {} as RunnerHandlers
        mocks.controlServer.mockImplementation(async (capturedHandlers: RunnerHandlers) => {
            handlers = capturedHandlers
            return { port: 0, stop: async () => {} }
        })
        // Fail registration twice with retryable connection errors: the
        // retry loop then idles through ~3s of backoff before succeeding —
        // long enough that a missing refresh would let the heartbeat go
        // stale against the 300s watchdog window in production.
        let attempts = 0
        mocks.getOrCreateMachine.mockImplementation(async () => {
            attempts++
            if (attempts <= 2) {
                throw retryableConnectionError()
            }
            return { id: 'machine-1' }
        })
        vi.spyOn(process, 'on').mockReturnValue(process)
        vi.spyOn(process, 'exit').mockImplementation(() => { throw captured })
        vi.stubEnv('HAPI_RUNNER_HANDOFF_FROM_PID', '')
        vi.stubEnv('HAPI_RUNNER_HEARTBEAT_INTERVAL', '3600000')
        vi.stubEnv('HAPI_DISABLE_VERSION_HANDOFF', '1')
        Object.defineProperty(configuration, 'runnerStateFile', { value: join(home, 'runner.json'), configurable: true })
        runnerPromise = startRunner()
        // machineSyncClient only runs after registration succeeds.
        await vi.waitFor(() => expect(mocks.machineSyncStarted).toBe(true), { timeout: 20_000 })
    })

    afterAll(async () => {
        handlers.requestShutdown()
        await expect(runnerPromise).rejects.toBe(captured)
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        rmSync(home, { recursive: true, force: true })
    })

    it('refreshes the heartbeat on every registration retry iteration', () => {
        expect(mocks.getOrCreateMachine).toHaveBeenCalledTimes(3)
        // One touch at startup (before registration) plus one per failed
        // attempt: the retry window must never read as a frozen loop.
        expect(mocks.touchRunnerHeartbeat).toHaveBeenCalledTimes(3)
    })

    it('clears the heartbeat file on graceful shutdown', async () => {
        expect(mocks.clearRunnerHeartbeat).not.toHaveBeenCalled()
        handlers.requestShutdown()
        await expect(runnerPromise).rejects.toBe(captured)
        expect(mocks.clearRunnerHeartbeat).toHaveBeenCalledTimes(1)
    })
})

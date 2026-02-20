import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    mockStartRunner,
    mockCheckRunnerRunning,
    mockListRunnerSessions,
    mockStopRunner,
    mockStopRunnerSession,
    mockGetLatestRunnerLog,
    mockSpawnHappyCLI,
    mockRunDoctorCommand,
    mockInitializeToken,
    mockReadSettings,
    mockRestartSessionsViaHub
} = vi.hoisted(() => ({
    mockStartRunner: vi.fn(),
    mockCheckRunnerRunning: vi.fn(),
    mockListRunnerSessions: vi.fn(),
    mockStopRunner: vi.fn(),
    mockStopRunnerSession: vi.fn(),
    mockGetLatestRunnerLog: vi.fn(),
    mockSpawnHappyCLI: vi.fn(),
    mockRunDoctorCommand: vi.fn(),
    mockInitializeToken: vi.fn(),
    mockReadSettings: vi.fn(),
    mockRestartSessionsViaHub: vi.fn()
}))

vi.mock('@/runner/run', () => ({
    startRunner: mockStartRunner
}))

vi.mock('@/runner/controlClient', () => ({
    checkIfRunnerRunningAndCleanupStaleState: mockCheckRunnerRunning,
    listRunnerSessions: mockListRunnerSessions,
    stopRunner: mockStopRunner,
    stopRunnerSession: mockStopRunnerSession
}))

vi.mock('@/ui/logger', () => ({
    getLatestRunnerLog: mockGetLatestRunnerLog
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: mockSpawnHappyCLI
}))

vi.mock('@/ui/doctor', () => ({
    runDoctorCommand: mockRunDoctorCommand
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: mockInitializeToken
}))

vi.mock('@/persistence', () => ({
    readSettings: mockReadSettings
}))

vi.mock('@/api/hubClient', () => ({
    restartSessionsViaHub: mockRestartSessionsViaHub
}))

import { runnerCommand } from './runner'

function invokeRunner(commandArgs: string[]): Promise<void> {
    return runnerCommand.run({
        args: ['runner', ...commandArgs],
        subcommand: 'runner',
        commandArgs
    })
}

describe('runner restart-sessions subcommand', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockInitializeToken.mockResolvedValue(undefined)
        mockReadSettings.mockResolvedValue({ machineId: 'machine-local-1' })
        mockRestartSessionsViaHub.mockResolvedValue({ results: [] })
    })

    it('initializes token before requesting restarts and forwards selected session IDs', async () => {
        const callOrder: string[] = []
        mockInitializeToken.mockImplementation(async () => {
            callOrder.push('initializeToken')
        })
        mockReadSettings.mockImplementation(async () => {
            callOrder.push('readSettings')
            return { machineId: 'machine-local-1' }
        })
        mockRestartSessionsViaHub.mockImplementation(async () => {
            callOrder.push('restartSessionsViaHub')
            return {
                results: [{ sessionId: 'session-1', name: null, status: 'restarted' }]
            }
        })

        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`)
        }) as never)

        await expect(invokeRunner(['restart-sessions', 'session-1', 'session-2'])).rejects.toThrow('process.exit:0')

        expect(callOrder).toEqual([
            'initializeToken',
            'readSettings',
            'restartSessionsViaHub'
        ])
        expect(mockRestartSessionsViaHub).toHaveBeenCalledWith({
            machineId: 'machine-local-1',
            sessionIds: ['session-1', 'session-2']
        })
    })

    it('fails closed when no machineId is available in local settings', async () => {
        mockReadSettings.mockResolvedValue({})

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`)
        }) as never)

        await expect(invokeRunner(['restart-sessions'])).rejects.toThrow('process.exit:1')

        expect(mockRestartSessionsViaHub).not.toHaveBeenCalled()
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('machineId'))
    })

    it('prints no-op message and exits 0 when no active sessions match', async () => {
        mockRestartSessionsViaHub.mockResolvedValue({ results: [] })

        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`)
        }) as never)

        await expect(invokeRunner(['restart-sessions'])).rejects.toThrow('process.exit:0')

        expect(consoleLog).toHaveBeenCalledWith('No active sessions to restart')
        expect(mockRestartSessionsViaHub).toHaveBeenCalledWith({
            machineId: 'machine-local-1',
            sessionIds: undefined
        })
    })

    it('exits 1 when any session fails to restart', async () => {
        mockRestartSessionsViaHub.mockResolvedValue({
            results: [
                { sessionId: 'session-1', name: null, status: 'restarted' },
                { sessionId: 'session-2', name: 'Broken', status: 'failed', error: 'no_machine_online' }
            ]
        })

        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 0}`)
        }) as never)

        await expect(invokeRunner(['restart-sessions'])).rejects.toThrow('process.exit:1')
    })
})

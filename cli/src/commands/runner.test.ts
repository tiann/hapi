import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    checkIfRunnerRunningAndCleanupStaleStateMock,
    listRunnerSessionsMock,
    stopRunnerMock,
    stopRunnerSessionMock,
    spawnHappyCLIMock,
    startRunnerMock,
    getLatestRunnerLogMock,
    runDoctorCommandMock,
    initializeTokenMock,
    existsSyncMock,
    statSyncMock
} = vi.hoisted(() => ({
    checkIfRunnerRunningAndCleanupStaleStateMock: vi.fn(),
    listRunnerSessionsMock: vi.fn(async () => []),
    stopRunnerMock: vi.fn(async () => {}),
    stopRunnerSessionMock: vi.fn(async () => true),
    spawnHappyCLIMock: vi.fn(() => ({ unref: vi.fn() })),
    startRunnerMock: vi.fn(async () => {}),
    getLatestRunnerLogMock: vi.fn(async () => null),
    runDoctorCommandMock: vi.fn(async () => {}),
    initializeTokenMock: vi.fn(async () => {}),
    existsSyncMock: vi.fn(() => true),
    statSyncMock: vi.fn(() => ({ isDirectory: () => true }))
}))

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
        ...actual,
        existsSync: existsSyncMock,
        statSync: statSyncMock
    }
})

vi.mock('@/runner/controlClient', () => ({
    checkIfRunnerRunningAndCleanupStaleState: checkIfRunnerRunningAndCleanupStaleStateMock,
    listRunnerSessions: listRunnerSessionsMock,
    stopRunner: stopRunnerMock,
    stopRunnerSession: stopRunnerSessionMock
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: spawnHappyCLIMock
}))

vi.mock('@/runner/run', () => ({
    startRunner: startRunnerMock
}))

vi.mock('@/ui/logger', () => ({
    getLatestRunnerLog: getLatestRunnerLogMock
}))

vi.mock('@/ui/doctor', () => ({
    runDoctorCommand: runDoctorCommandMock
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: initializeTokenMock
}))

import { runnerCommand } from './runner'

function createContext(commandArgs: string[]) {
    return {
        args: ['runner', ...commandArgs],
        commandArgs
    }
}

describe('runnerCommand start', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        existsSyncMock.mockReturnValue(true)
        statSyncMock.mockReturnValue({ isDirectory: () => true })
    })

    it('stops an existing runner before starting a new detached runner', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        checkIfRunnerRunningAndCleanupStaleStateMock
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)

        try {
            await expect(runnerCommand.run(createContext(['start', '--workspace-root', '/workspace']))).rejects.toThrow('process.exit:0')

            expect(stopRunnerMock).toHaveBeenCalledOnce()
            expect(spawnHappyCLIMock).toHaveBeenCalledWith(['runner', 'start-sync', '--workspace-root', '/workspace'], {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
            expect(stopRunnerMock.mock.invocationCallOrder[0]).toBeLessThan(spawnHappyCLIMock.mock.invocationCallOrder[0])
            expect(consoleLogSpy).toHaveBeenCalledWith('Existing runner detected, stopping it before starting a new one...')
            expect(consoleLogSpy).toHaveBeenCalledWith('Runner started successfully')
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('starts directly when no runner is already running', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        checkIfRunnerRunningAndCleanupStaleStateMock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)

        try {
            await expect(runnerCommand.run(createContext(['start']))).rejects.toThrow('process.exit:0')

            expect(stopRunnerMock).not.toHaveBeenCalled()
            expect(spawnHappyCLIMock).toHaveBeenCalledOnce()
            expect(consoleLogSpy).toHaveBeenCalledWith('Runner started successfully')
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })
})

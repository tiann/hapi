import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    checkIfRunnerRunningAndCleanupStaleStateMock,
    listRunnerSessionsMock,
    stopRunnerMock,
    stopRunnerSessionMock,
    spawnHappyCLIMock,
    getHappyCliCommandMock,
    nativeSpawnDetachedMock,
    startRunnerMock,
    getLatestRunnerLogMock,
    runDoctorCommandMock,
    initializeTokenMock,
    installRunnerServiceMock,
    uninstallRunnerServiceMock,
    getRunnerServiceStatusMock,
    existsSyncMock,
    statSyncMock
} = vi.hoisted(() => ({
    checkIfRunnerRunningAndCleanupStaleStateMock: vi.fn(),
    listRunnerSessionsMock: vi.fn(async () => []),
    stopRunnerMock: vi.fn(async () => {}),
    stopRunnerSessionMock: vi.fn(async () => true),
    spawnHappyCLIMock: vi.fn(() => ({ unref: vi.fn() })),
    getHappyCliCommandMock: vi.fn((args: string[]) => ({ command: '/bin/hapi', args })),
    nativeSpawnDetachedMock: vi.fn(async (): Promise<number | null> => 12345),
    startRunnerMock: vi.fn(async () => {}),
    getLatestRunnerLogMock: vi.fn(async () => null),
    runDoctorCommandMock: vi.fn(async () => {}),
    initializeTokenMock: vi.fn(async () => {}),
    installRunnerServiceMock: vi.fn(async () => ({
        servicePath: '/service/path',
        persistedApiUrl: false,
        persistedToken: false
    })),
    uninstallRunnerServiceMock: vi.fn(async () => ({ servicePath: '/service/path' })),
    getRunnerServiceStatusMock: vi.fn(async () => 'service status'),
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
    spawnHappyCLI: spawnHappyCLIMock,
    getHappyCliCommand: getHappyCliCommandMock
}))

vi.mock('@/native/process', () => ({
    nativeSpawnDetached: nativeSpawnDetachedMock
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

vi.mock('@/runner/service', () => ({
    installRunnerService: installRunnerServiceMock,
    uninstallRunnerService: uninstallRunnerServiceMock,
    getRunnerServiceStatus: getRunnerServiceStatusMock
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
            expect(nativeSpawnDetachedMock).toHaveBeenCalledWith({
                command: '/bin/hapi',
                args: ['runner', 'start-sync', '--workspace-root', '/workspace'],
                env: process.env
            })
            expect(spawnHappyCLIMock).not.toHaveBeenCalled()
            expect(stopRunnerMock.mock.invocationCallOrder[0]).toBeLessThan(nativeSpawnDetachedMock.mock.invocationCallOrder[0])
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
            expect(nativeSpawnDetachedMock).toHaveBeenCalledOnce()
            expect(spawnHappyCLIMock).not.toHaveBeenCalled()
            expect(consoleLogSpy).toHaveBeenCalledWith('Runner started successfully')
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('falls back to TS spawn when native helper is unavailable', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        nativeSpawnDetachedMock.mockResolvedValueOnce(null)
        checkIfRunnerRunningAndCleanupStaleStateMock
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)

        try {
            await expect(runnerCommand.run(createContext(['start']))).rejects.toThrow('process.exit:0')

            expect(spawnHappyCLIMock).toHaveBeenCalledWith(['runner', 'start-sync'], {
                detached: true,
                stdio: 'ignore',
                env: process.env
            })
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

})

describe('runnerCommand service', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        existsSyncMock.mockReturnValue(true)
        statSyncMock.mockReturnValue({ isDirectory: () => true })
        installRunnerServiceMock.mockResolvedValue({
            servicePath: '/service/path',
            persistedApiUrl: false,
            persistedToken: false
        })
    })

    it('installs an auto-start service with workspace roots after stopping existing runner', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        checkIfRunnerRunningAndCleanupStaleStateMock
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)

        try {
            await expect(runnerCommand.run(createContext(['service', 'install', '--workspace-root', '/workspace']))).rejects.toThrow('process.exit:0')

            expect(stopRunnerMock).toHaveBeenCalledOnce()
            expect(installRunnerServiceMock).toHaveBeenCalledWith({ workspaceRoots: ['/workspace'] })
            expect(consoleLogSpy).toHaveBeenCalledWith('Runner auto-start service installed')
            expect(consoleLogSpy).toHaveBeenCalledWith('  Runner will start automatically after reboot/login')
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('prints service status', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        try {
            await expect(runnerCommand.run(createContext(['service', 'status']))).rejects.toThrow('process.exit:0')

            expect(getRunnerServiceStatusMock).toHaveBeenCalledOnce()
            expect(consoleLogSpy).toHaveBeenCalledWith('service status')
        } finally {
            consoleLogSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })
})

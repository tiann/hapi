import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInitializeToken = vi.fn()
const mockMaybeAutoStartServer = vi.fn()
const mockAuthAndSetupMachineIfNeeded = vi.fn()
const mockIsRunnerRunningCurrentlyInstalledHappyVersion = vi.fn()
const mockSpawnHappyCLI = vi.fn()
const mockRunClaude = vi.fn()

vi.mock('@/configuration', () => ({
    configuration: {
        apiUrl: 'http://example.test'
    }
}))

vi.mock('@/runner/controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: mockIsRunnerRunningCurrentlyInstalledHappyVersion
}))

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: mockAuthAndSetupMachineIfNeeded
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: mockInitializeToken
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: mockSpawnHappyCLI
}))

vi.mock('@/utils/autoStartServer', () => ({
    maybeAutoStartServer: mockMaybeAutoStartServer
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: vi.fn(() => process.env)
}))

vi.mock('@/utils/errorUtils', () => ({
    extractErrorInfo: vi.fn(() => ({
        message: 'boom',
        messageLower: 'boom'
    }))
}))

describe('claudeCommand runner availability gating', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockInitializeToken.mockResolvedValue(undefined)
        mockMaybeAutoStartServer.mockResolvedValue(undefined)
        mockAuthAndSetupMachineIfNeeded.mockResolvedValue(undefined)
        mockIsRunnerRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)
        mockRunClaude.mockResolvedValue(undefined)
        mockSpawnHappyCLI.mockReturnValue({
            unref: vi.fn()
        })
    })

    it('starts runner when reusable-health check is false so degraded control plane is not treated as ready', async () => {
        mockIsRunnerRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
        const { claudeCommand } = await import('./claude')

        await claudeCommand.run({ commandArgs: [] } as never)

        expect(mockSpawnHappyCLI).toHaveBeenCalledWith(['runner', 'start-sync'], {
            detached: true,
            stdio: 'ignore',
            env: process.env
        })
        expect(mockRunClaude).toHaveBeenCalledTimes(1)
    })

    it('skips runner start when reusable-health check is true', async () => {
        const { claudeCommand } = await import('./claude')

        await claudeCommand.run({ commandArgs: [] } as never)

        expect(mockSpawnHappyCLI).not.toHaveBeenCalled()
        expect(mockRunClaude).toHaveBeenCalledTimes(1)
    })
})

vi.mock('@/claude/runClaude', () => ({
    runClaude: mockRunClaude
}))

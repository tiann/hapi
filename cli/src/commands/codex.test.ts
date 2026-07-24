import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    assertCodexLocalSupportedMock,
    applyProviderSelectionMock,
    runCodexMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => {}),
    assertCodexLocalSupportedMock: vi.fn(),
    applyProviderSelectionMock: vi.fn(async (): Promise<null | {
        env: Record<string, string>
        args: string[]
        defaultModel?: string
        profile: { id: string; name: string; revision: number }
    }> => null),
    runCodexMock: vi.fn(async () => {})
}))

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: initializeTokenMock
}))

vi.mock('@/utils/autoStartServer', () => ({
    maybeAutoStartServer: maybeAutoStartServerMock
}))

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: authAndSetupMachineIfNeededMock
}))

vi.mock('@/codex/utils/codexVersion', () => ({
    assertCodexLocalSupported: assertCodexLocalSupportedMock
}))

vi.mock('@/codex/runCodex', () => ({
    runCodex: runCodexMock
}))

vi.mock('@/host/applyProviderSelection', () => ({
    applyProviderSelection: applyProviderSelectionMock
}))

import { codexCommand } from './codex'

function createCommandContext(commandArgs: string[]) {
    return {
        args: ['codex', ...commandArgs],
        commandArgs
    }
}

describe('codexCommand', () => {
    beforeEach(() => {
        initializeTokenMock.mockClear()
        maybeAutoStartServerMock.mockClear()
        authAndSetupMachineIfNeededMock.mockClear()
        assertCodexLocalSupportedMock.mockClear()
        applyProviderSelectionMock.mockReset()
        applyProviderSelectionMock.mockResolvedValue(null)
        runCodexMock.mockClear()
    })

    it('checks Codex version before starting a local session', async () => {
        await codexCommand.run(createCommandContext([]))

        expect(assertCodexLocalSupportedMock).toHaveBeenCalledOnce()
        expect(initializeTokenMock).toHaveBeenCalledOnce()
        expect(maybeAutoStartServerMock).toHaveBeenCalledOnce()
        expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledOnce()
        expect(runCodexMock).toHaveBeenCalledWith({})
    })

    it('does not block local Codex startup on Hub auto-start readiness', async () => {
        maybeAutoStartServerMock.mockImplementationOnce(async () => {
            await new Promise(() => {})
        })

        await codexCommand.run(createCommandContext([]))

        expect(runCodexMock).toHaveBeenCalledOnce()
        expect(maybeAutoStartServerMock).toHaveBeenCalledWith({
            waitForReady: false,
            quiet: true
        })
    })

    it('checks Codex version before resuming a local session', async () => {
        await codexCommand.run(createCommandContext(['resume', 'session-123']))

        expect(assertCodexLocalSupportedMock).toHaveBeenCalledOnce()
        expect(runCodexMock).toHaveBeenCalledWith({
            resumeSessionId: 'session-123'
        })
    })

    it('skips the local version check for runner-started sessions', async () => {
        await codexCommand.run(createCommandContext(['--started-by', 'runner']))

        expect(assertCodexLocalSupportedMock).not.toHaveBeenCalled()
        expect(runCodexMock).toHaveBeenCalledWith({
            startedBy: 'runner'
        })
    })

    it('forwards a valid --service-tier to runCodex', async () => {
        await codexCommand.run(createCommandContext(['--started-by', 'runner', '--service-tier', 'fast']))

        expect(runCodexMock).toHaveBeenCalledWith({
            startedBy: 'runner',
            serviceTier: 'fast'
        })
    })

    it('selects a managed provider and uses its default model', async () => {
        applyProviderSelectionMock.mockResolvedValueOnce({
            env: {},
            args: [],
            defaultModel: 'provider-model',
            profile: { id: '11111111-1111-4111-8111-111111111111', name: 'Provider', revision: 1 }
        })

        await codexCommand.run(createCommandContext([
            '--hapi-provider',
            '11111111-1111-4111-8111-111111111111'
        ]))

        expect(applyProviderSelectionMock).toHaveBeenCalledWith('codex', '11111111-1111-4111-8111-111111111111')
        expect(runCodexMock).toHaveBeenCalledWith({ model: 'provider-model' })
    })

    it('allows an explicit system-provider selection', async () => {
        await codexCommand.run(createCommandContext(['--hapi-provider', 'system']))

        expect(applyProviderSelectionMock).toHaveBeenCalledWith('codex', null)
        expect(runCodexMock).toHaveBeenCalledWith({})
    })

    it('rejects an unsupported --service-tier value', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        try {
            await expect(
                codexCommand.run(createCommandContext(['--started-by', 'runner', '--service-tier', 'turbo']))
            ).rejects.toThrow('process.exit:1')
            expect(runCodexMock).not.toHaveBeenCalled()
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), 'Invalid --service-tier value')
        } finally {
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('accepts and normalizes a dynamic model reasoning effort', async () => {
        await codexCommand.run(createCommandContext([
            '--started-by',
            'runner',
            '--model-reasoning-effort',
            ' EXTREME '
        ]))

        expect(runCodexMock).toHaveBeenCalledWith({
            startedBy: 'runner',
            modelReasoningEffort: 'extreme'
        })
    })

    it('prints the upgrade error and exits when the local version check fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        assertCodexLocalSupportedMock.mockImplementationOnce(() => {
            throw new Error('Codex CLI 0.124.0+ is required')
        })

        try {
            await expect(codexCommand.run(createCommandContext([]))).rejects.toThrow('process.exit:1')

            expect(runCodexMock).not.toHaveBeenCalled()
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), 'Codex CLI 0.124.0+ is required')
        } finally {
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })
})

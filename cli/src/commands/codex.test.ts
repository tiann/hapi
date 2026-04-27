import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    assertCodexLocalSupportedMock,
    runCodexMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => {}),
    assertCodexLocalSupportedMock: vi.fn(),
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

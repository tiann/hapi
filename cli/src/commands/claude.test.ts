import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    runClaudeMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => {}),
    runClaudeMock: vi.fn(async () => {})
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

vi.mock('@/runner/controlClient', () => ({
    isRunnerRunningCurrentlyInstalledHappyVersion: async () => true
}))

vi.mock('@/claude/runClaude', () => ({
    runClaude: runClaudeMock
}))

import { claudeCommand } from './claude'

function createCommandContext(commandArgs: string[]) {
    return {
        args: commandArgs,
        commandArgs
    }
}

describe('claudeCommand arguments', () => {
    beforeEach(() => {
        initializeTokenMock.mockClear()
        maybeAutoStartServerMock.mockClear()
        authAndSetupMachineIfNeededMock.mockClear()
        runClaudeMock.mockClear()
    })

    it('tracks --model as session state instead of an opaque Claude argument', async () => {
        await claudeCommand.run(createCommandContext(['--model', 'claude-opus-4-1']))

        expect(runClaudeMock).toHaveBeenCalledWith({ model: 'claude-opus-4-1' })
    })

    it('supports the --model=value form as session state', async () => {
        await claudeCommand.run(createCommandContext(['--model=claude-opus-4-1']))

        expect(runClaudeMock).toHaveBeenCalledWith({ model: 'claude-opus-4-1' })
    })

    it.each(['--help', '-h', '--version', '-v', 'claude'])('forwards %s without special handling', async (arg) => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await claudeCommand.run(createCommandContext([arg]))
            expect(runClaudeMock).toHaveBeenCalledWith({ claudeArgs: [arg] })
            expect(logSpy).not.toHaveBeenCalled()
        } finally {
            logSpy.mockRestore()
        }
    })

    it('keeps arguments after -- opaque', async () => {
        const args = ['--', '--model', 'literal', '--help']
        await claudeCommand.run(createCommandContext(args))
        expect(runClaudeMock).toHaveBeenCalledWith({ claudeArgs: args })
    })
})

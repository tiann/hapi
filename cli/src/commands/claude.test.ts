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

    it('passes --hapi-session-id as reservedSessionId (adopt-stub, not reopen) (#1911)', async () => {
        await claudeCommand.run(createCommandContext([
            '--started-by', 'runner',
            '--hapi-starting-mode', 'remote',
            '--hapi-session-id', 'preallocated-hub-id',
        ]))

        expect(runClaudeMock).toHaveBeenCalledWith({
            startedBy: 'runner',
            startingMode: 'remote',
            reservedSessionId: 'preallocated-hub-id',
        })
    })

    it('passes --existing-session-id through for Claude fork/reuse', async () => {
        await claudeCommand.run(createCommandContext([
            '--existing-session-id', 'fork-child-id',
        ]))

        expect(runClaudeMock).toHaveBeenCalledWith({
            existingSessionId: 'fork-child-id',
        })
    })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    runClaudeMock,
    getLocalResumeTargetByAgentSessionIdMock,
    listResumableSessionsMock,
    getLocalResumeTargetMock,
    handoffSessionToLocalMock,
    prepareSessionForLocalResumeMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => ({ token: 'token', machineId: 'machine-1' })),
    runClaudeMock: vi.fn(async () => {}),
    getLocalResumeTargetByAgentSessionIdMock: vi.fn(),
    listResumableSessionsMock: vi.fn(async () => []),
    getLocalResumeTargetMock: vi.fn(),
    handoffSessionToLocalMock: vi.fn(async () => {}),
    prepareSessionForLocalResumeMock: vi.fn(async () => {})
}))

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getLocalResumeTargetByAgentSessionId: getLocalResumeTargetByAgentSessionIdMock,
            listResumableSessions: listResumableSessionsMock,
            getLocalResumeTarget: getLocalResumeTargetMock,
            handoffSessionToLocal: handoffSessionToLocalMock,
            prepareSessionForLocalResume: prepareSessionForLocalResumeMock
        })
    }
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
import { getProjectPath } from '@/claude/utils/path'

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
        getLocalResumeTargetByAgentSessionIdMock.mockReset()
        listResumableSessionsMock.mockClear()
        getLocalResumeTargetMock.mockReset()
        handoffSessionToLocalMock.mockClear()
    })

    it('tracks --model as session state instead of an opaque Claude argument', async () => {
        await claudeCommand.run(createCommandContext(['--model', 'claude-opus-4-1']))

        expect(runClaudeMock).toHaveBeenCalledWith({ model: 'claude-opus-4-1' })
    })

    it('supports the --model=value form as session state', async () => {
        await claudeCommand.run(createCommandContext(['--model=claude-opus-4-1']))

        expect(runClaudeMock).toHaveBeenCalledWith({ model: 'claude-opus-4-1' })
    })

    it.each(['--yolo', '--dangerously-skip-permissions'])('tracks %s as session permission mode without forwarding it', async (arg) => {
        await claudeCommand.run(createCommandContext([arg]))

        expect(runClaudeMock).toHaveBeenCalledWith({ permissionMode: 'bypassPermissions' })
    })

    it('keeps an explicit --permission-mode over a later --dangerously-skip-permissions', async () => {
        await claudeCommand.run(createCommandContext(['--permission-mode', 'default', '--dangerously-skip-permissions']))

        expect(runClaudeMock).toHaveBeenCalledWith({ permissionMode: 'default' })
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

describe('claudeCommand resume identity', () => {
    const claudeId = '7e6b91b1-d91e-4a32-9ac6-d16b2e354a4a'
    const directory = process.cwd()

    function owner(overrides: Record<string, unknown> = {}) {
        return {
            sessionId: 'hapi-owner',
            flavor: 'claude',
            directory,
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: claudeId,
            model: 'opus',
            effort: 'high',
            permissionMode: 'bypassPermissions',
            ...overrides
        }
    }

    // Resume targets need a local transcript; give each test its own Claude config dir.
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    // getInvokedCwd() prefers HAPI_INVOKED_CWD over process.cwd() — running
    // this suite itself inside a HAPI-wrapped session (this one included)
    // leaks that var in, so the fixture written under process.cwd() below
    // would silently resolve against a different directory than the command
    // actually looks in. Clear it for the duration so resolution matches
    // where `directory` points, same as CI (where the var is unset).
    const originalHapiInvokedCwd = process.env.HAPI_INVOKED_CWD
    let claudeConfigDir = ''

    beforeEach(() => {
        runClaudeMock.mockClear()
        getLocalResumeTargetByAgentSessionIdMock.mockReset()
        handoffSessionToLocalMock.mockClear()
        prepareSessionForLocalResumeMock.mockClear()
        delete process.env.HAPI_INVOKED_CWD
        claudeConfigDir = mkdtempSync(join(tmpdir(), 'hapi-claude-resume-'))
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
        const projectDir = getProjectPath(directory)
        mkdirSync(projectDir, { recursive: true })
        writeFileSync(join(projectDir, `${claudeId}.jsonl`), `${JSON.stringify({ uuid: 'm1' })}\n`)
    })

    afterEach(() => {
        if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        if (originalHapiInvokedCwd === undefined) delete process.env.HAPI_INVOKED_CWD
        else process.env.HAPI_INVOKED_CWD = originalHapiInvokedCwd
        rmSync(claudeConfigDir, { recursive: true, force: true })
    })

    it('refuses an explicit resume whose transcript is gone instead of starting a fresh conversation', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        rmSync(join(getProjectPath(directory), `${claudeId}.jsonl`))
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({ target: owner({ active: true }), historical: false })
        try {
            await expect(claudeCommand.run(createCommandContext(['--resume', claudeId]))).rejects.toThrow('process.exit:1')
            expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('has no transcript'))
            expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
            expect(prepareSessionForLocalResumeMock).not.toHaveBeenCalled()
            expect(runClaudeMock).not.toHaveBeenCalled()
        } finally {
            errorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('reopens the owning HAPI session instead of creating a new one', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({ target: owner(), historical: false })
        try {
            await claudeCommand.run(createCommandContext(['--resume', claudeId, '--verbose']))
        } finally {
            logSpy.mockRestore()
        }

        expect(getLocalResumeTargetByAgentSessionIdMock).toHaveBeenCalledWith(claudeId, 'machine-1')
        expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
        // Inactive (possibly hub-archived) owner: the hub clears the archive
        // before existing-session bootstrap would refuse it.
        expect(prepareSessionForLocalResumeMock).toHaveBeenCalledWith('hapi-owner')
        expect(prepareSessionForLocalResumeMock.mock.invocationCallOrder[0])
            .toBeLessThan(runClaudeMock.mock.invocationCallOrder[0]!)
        expect(runClaudeMock).toHaveBeenCalledWith({
            existingSessionId: 'hapi-owner',
            resumeSessionId: claudeId,
            workingDirectory: directory,
            startingMode: 'local',
            claudeArgs: ['--verbose'],
            permissionMode: 'bypassPermissions',
            model: 'opus',
            effort: 'high'
        })
    })

    it('takes control of a session that is running remotely before reopening it', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({ target: owner({ active: true }), historical: false })
        try {
            await claudeCommand.run(createCommandContext(['-r', claudeId, '--model', 'sonnet']))
        } finally {
            logSpy.mockRestore()
        }

        expect(handoffSessionToLocalMock).toHaveBeenCalledWith('hapi-owner')
        expect(prepareSessionForLocalResumeMock).not.toHaveBeenCalled()
        // An explicit CLI flag still wins over the session's stored model.
        expect(runClaudeMock).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'hapi-owner', model: 'sonnet' }))
    })

    it('refuses to start a second terminal on a locally controlled session', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({
            target: owner({ active: true, controlledByUser: true }),
            historical: false
        })
        try {
            await expect(claudeCommand.run(createCommandContext(['-r', claudeId]))).rejects.toThrow('process.exit:1')
            expect(errorSpy).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('/sessions/hapi-owner'))
            expect(runClaudeMock).not.toHaveBeenCalled()
            expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
        } finally {
            errorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('resolves --continue to the owner of the newest transcript and prepares it before reopening', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({ target: owner(), historical: false })
        try {
            await claudeCommand.run(createCommandContext(['--continue']))
        } finally {
            logSpy.mockRestore()
        }

        expect(getLocalResumeTargetByAgentSessionIdMock).toHaveBeenCalledWith(claudeId, 'machine-1')
        expect(prepareSessionForLocalResumeMock).toHaveBeenCalledWith('hapi-owner')
        expect(runClaudeMock).toHaveBeenCalledWith(expect.objectContaining({
            existingSessionId: 'hapi-owner',
            resumeSessionId: claudeId
        }))
        expect(runClaudeMock).not.toHaveBeenCalledWith(expect.objectContaining({
            claudeArgs: expect.arrayContaining(['--continue'])
        }))
    })

    it('keeps the original resume args when no HAPI session owns the conversation', async () => {
        getLocalResumeTargetByAgentSessionIdMock.mockResolvedValue({ target: null, historical: false })

        await claudeCommand.run(createCommandContext(['-r', claudeId]))

        expect(runClaudeMock).toHaveBeenCalledWith({ claudeArgs: ['-r', claudeId] })
    })

    it('does not resolve identity for forks or runner spawns', async () => {
        await claudeCommand.run(createCommandContext(['--resume', claudeId, '--fork-session']))
        await claudeCommand.run(createCommandContext(['--started-by', 'runner', '--resume', claudeId]))

        expect(getLocalResumeTargetByAgentSessionIdMock).not.toHaveBeenCalled()
        expect(runClaudeMock).toHaveBeenNthCalledWith(1, { claudeArgs: ['--resume', claudeId, '--fork-session'] })
    })
})

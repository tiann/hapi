import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    runClaudeMock,
    spawnHappyCLIMock,
    isRunnerVersionCurrentMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => {}),
    runClaudeMock: vi.fn(async () => {}),
    spawnHappyCLIMock: vi.fn((): unknown => ({ pid: 4242, unref: () => {} })),
    isRunnerVersionCurrentMock: vi.fn(async () => true)
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
    isRunnerRunningCurrentlyInstalledHappyVersion: isRunnerVersionCurrentMock
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: spawnHappyCLIMock
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
        spawnHappyCLIMock.mockClear()
        isRunnerVersionCurrentMock.mockReset()
        isRunnerVersionCurrentMock.mockResolvedValue(true)
        delete process.env.HAPI_RUNNER_SPAWNED_SESSION
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

describe('claudeCommand stale-runner replacement', () => {
    beforeEach(() => {
        initializeTokenMock.mockClear()
        maybeAutoStartServerMock.mockClear()
        authAndSetupMachineIfNeededMock.mockClear()
        runClaudeMock.mockClear()
        spawnHappyCLIMock.mockClear()
        isRunnerVersionCurrentMock.mockReset()
        delete process.env.HAPI_RUNNER_SPAWNED_SESSION
    })

    it('spawns a replacement runner when the installed one is stale (terminal session)', async () => {
        isRunnerVersionCurrentMock.mockResolvedValue(false)
        await claudeCommand.run(createCommandContext([]))
        expect(spawnHappyCLIMock).toHaveBeenCalledWith(
            ['runner', 'start-sync'],
            expect.objectContaining({ detached: true })
        )
        expect(runClaudeMock).toHaveBeenCalled()
    })

    it('leaves the replacement to the runner heartbeat for runner-started sessions', async () => {
        // A runner-started session is demoted (nice); a replacement runner
        // spawned from here would inherit that demotion forever. The
        // runner's own heartbeat handoff replaces it undemoted instead.
        isRunnerVersionCurrentMock.mockResolvedValue(false)
        process.env.HAPI_RUNNER_SPAWNED_SESSION = '1'
        await claudeCommand.run(createCommandContext([]))
        expect(spawnHappyCLIMock).not.toHaveBeenCalled()
        expect(runClaudeMock).toHaveBeenCalled()
    })
})

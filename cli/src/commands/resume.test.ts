import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
    initializeTokenMock,
    maybeAutoStartServerMock,
    authAndSetupMachineIfNeededMock,
    listResumableSessionsMock,
    getLocalResumeTargetMock,
    handoffSessionToLocalMock,
    renderMock,
    runCodexMock,
    runClaudeMock,
    runGrokMock,
    runPiMock,
    assertCodexLocalSupportedMock,
    existsSyncMock
} = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    maybeAutoStartServerMock: vi.fn(async () => {}),
    authAndSetupMachineIfNeededMock: vi.fn(async () => ({ machineId: 'machine-1' })),
    listResumableSessionsMock: vi.fn(),
    getLocalResumeTargetMock: vi.fn(),
    handoffSessionToLocalMock: vi.fn(async () => {}),
    renderMock: vi.fn(),
    runCodexMock: vi.fn(async () => {}),
    runClaudeMock: vi.fn(async () => {}),
    runGrokMock: vi.fn(async () => {}),
    runPiMock: vi.fn(async () => {}),
    assertCodexLocalSupportedMock: vi.fn(),
    existsSyncMock: vi.fn(() => true)
}))

vi.mock('@/ui/tokenInit', () => ({ initializeToken: initializeTokenMock }))
vi.mock('@/utils/autoStartServer', () => ({ maybeAutoStartServer: maybeAutoStartServerMock }))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: authAndSetupMachineIfNeededMock }))
vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            listResumableSessions: listResumableSessionsMock,
            getLocalResumeTarget: getLocalResumeTargetMock,
            handoffSessionToLocal: handoffSessionToLocalMock
        })
    }
}))
vi.mock('ink', () => ({ render: renderMock }))
vi.mock('@/ui/ink/ResumeSessionPicker', () => ({
    ResumeSessionPicker: 'ResumeSessionPicker'
}))
vi.mock('@/codex/runCodex', () => ({ runCodex: runCodexMock }))
vi.mock('@/claude/runClaude', () => ({ runClaude: runClaudeMock }))
vi.mock('@/grok/runGrok', () => ({ runGrok: runGrokMock }))
vi.mock('@/pi/runPi', () => ({ runPi: runPiMock }))
vi.mock('@/codex/utils/codexVersion', () => ({ assertCodexLocalSupported: assertCodexLocalSupportedMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))

import { resumeCommand } from './resume'

function createContext(commandArgs: string[]) {
    return {
        args: ['resume'].concat(commandArgs),
        subcommand: 'resume',
        commandArgs
    }
}

describe('resumeCommand', () => {
    beforeEach(() => {
        initializeTokenMock.mockClear()
        maybeAutoStartServerMock.mockClear()
        authAndSetupMachineIfNeededMock.mockClear()
        listResumableSessionsMock.mockReset()
        getLocalResumeTargetMock.mockReset()
        handoffSessionToLocalMock.mockClear()
        renderMock.mockReset()
        renderMock.mockImplementation((element: { props?: { onSelect?: (sessionId: string) => void } }) => {
            queueMicrotask(() => element.props?.onSelect?.('picked-session'))
            return { unmount: vi.fn() }
        })
        runCodexMock.mockClear()
        runClaudeMock.mockClear()
        runGrokMock.mockClear()
        runPiMock.mockClear()
        assertCodexLocalSupportedMock.mockClear()
        existsSyncMock.mockReturnValue(true)
    })

    it('resumes a Codex target by HAPI session id', async () => {
        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-1',
            flavor: 'codex',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: true,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'codex-thread-1',
            model: 'gpt-5.4',
            modelReasoningEffort: 'xhigh',
            permissionMode: 'default',
            collaborationMode: 'default'
        })

        await resumeCommand.run(createContext(['hapi-session-1']))

        expect(handoffSessionToLocalMock).toHaveBeenCalledWith('hapi-session-1')
        expect(assertCodexLocalSupportedMock).toHaveBeenCalledOnce()
        expect(runCodexMock).toHaveBeenCalledWith({
            existingSessionId: 'hapi-session-1',
            workingDirectory: '/tmp/project',
            resumeSessionId: 'codex-thread-1',
            startedBy: 'terminal',
            permissionMode: 'default',
            model: 'gpt-5.4',
            modelReasoningEffort: 'xhigh',
            collaborationMode: 'default'
        })
    })

    it('resumes an inactive Claude target without handoff', async () => {
        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-2',
            flavor: 'claude',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: '11111111-1111-4111-8111-111111111111',
            model: 'sonnet',
            effort: 'high',
            permissionMode: 'default'
        })

        await resumeCommand.run(createContext(['hapi-session-2']))

        expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
        expect(runClaudeMock).toHaveBeenCalledWith({
            existingSessionId: 'hapi-session-2',
            workingDirectory: '/tmp/project',
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
            startedBy: 'terminal',
            startingMode: 'local',
            permissionMode: 'default',
            model: 'sonnet',
            effort: 'high'
        })
    })

    it('resumes a Grok target in the native local TUI', async () => {
        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-grok',
            flavor: 'grok',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'grok-session-1',
            model: 'grok-4.5',
            effort: 'low',
            permissionMode: 'plan'
        })

        await resumeCommand.run(createContext(['hapi-session-grok']))

        expect(runGrokMock).toHaveBeenCalledWith({
            existingSessionId: 'hapi-session-grok',
            workingDirectory: '/tmp/project',
            resumeSessionId: 'grok-session-1',
            startedBy: 'terminal',
            permissionMode: 'plan',
            startingMode: 'local',
            model: 'grok-4.5',
            effort: 'low'
        })
    })

    it('rejects an active Gemini target before handoff (no longer supported, leaves running session alone)', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-gemini',
            flavor: 'gemini',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: true,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'gemini-conv-1',
            model: 'gemini-2.5-pro',
            permissionMode: 'default'
        })

        try {
            await expect(resumeCommand.run(createContext(['hapi-session-gemini']))).rejects.toThrow('process.exit:1')
            // Regression (#953): the gemini guard must fire BEFORE handoff so an
            // active Gemini session is not stopped and then left failing locally.
            expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('no longer supported'))
        } finally {
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('fails before launching when the target belongs to another machine', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-3',
            flavor: 'codex',
            directory: '/tmp/project',
            machineId: 'machine-2',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'codex-thread-1'
        })

        try {
            await expect(resumeCommand.run(createContext(['hapi-session-3']))).rejects.toThrow('process.exit:1')
            expect(runCodexMock).not.toHaveBeenCalled()
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('another machine'))
        } finally {
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('resumes an inactive local target even when controlledByUser is sticky', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)

        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-4',
            flavor: 'claude',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: true,
            agentSessionId: '11111111-1111-4111-8111-111111111111',
            permissionMode: 'default'
        })

        try {
            await resumeCommand.run(createContext(['hapi-session-4']))

            expect(exitSpy).not.toHaveBeenCalled()
            expect(consoleErrorSpy).not.toHaveBeenCalled()
            expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
            expect(runClaudeMock).toHaveBeenCalledWith(expect.objectContaining({
                existingSessionId: 'hapi-session-4',
                resumeSessionId: '11111111-1111-4111-8111-111111111111'
            }))
        } finally {
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })

    it('uses the interactive picker when no session id is provided on a TTY', async () => {
        const originalIsTTY = process.stdin.isTTY
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: true
        })
        listResumableSessionsMock.mockResolvedValue([
            {
                sessionId: 'picked-session',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 2,
                name: 'Picked'
            }
        ])
        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'picked-session',
            flavor: 'codex',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'codex-thread-1'
        })

        try {
            await resumeCommand.run(createContext([]))

            expect(renderMock).toHaveBeenCalledOnce()
            expect(getLocalResumeTargetMock).toHaveBeenCalledWith('picked-session')
            expect(runCodexMock).toHaveBeenCalledWith(expect.objectContaining({
                existingSessionId: 'picked-session',
                resumeSessionId: 'codex-thread-1'
            }))
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', {
                configurable: true,
                value: originalIsTTY
            })
        }
    })

    it('resumes a Pi target with effort', async () => {
        getLocalResumeTargetMock.mockResolvedValue({
            sessionId: 'hapi-session-pi',
            flavor: 'pi',
            directory: '/tmp/project',
            machineId: 'machine-1',
            active: false,
            thinking: false,
            controlledByUser: false,
            agentSessionId: 'pi-session-123',
            model: 'deepseek-v3',
            effort: 'high',
            permissionMode: 'yolo'
        })

        await resumeCommand.run(createContext(['hapi-session-pi']))

        expect(handoffSessionToLocalMock).not.toHaveBeenCalled()
        expect(runPiMock).toHaveBeenCalledWith({
            existingSessionId: 'hapi-session-pi',
            workingDirectory: '/tmp/project',
            resumeSessionId: 'pi-session-123',
            startedBy: 'terminal',
            // Pi has no local TUI input path, so resume defaults to remote control.
            startingMode: 'remote',
            model: 'deepseek-v3',
            effort: 'high'
        })
    })

    it('keeps the non-TTY fallback and asks for an explicit session id', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`process.exit:${code ?? 'undefined'}`)
        }) as never)
        const originalIsTTY = process.stdin.isTTY
        Object.defineProperty(process.stdin, 'isTTY', {
            configurable: true,
            value: false
        })
        listResumableSessionsMock.mockResolvedValue([
            {
                sessionId: 'hapi-session-1',
                flavor: 'claude',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'claude-session-1',
                updatedAt: 1
            }
        ])

        try {
            await expect(resumeCommand.run(createContext([]))).rejects.toThrow('process.exit:1')
            expect(renderMock).not.toHaveBeenCalled()
            expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('hapi-session-1'))
            expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), 'Run: hapi resume <session-id>')
        } finally {
            Object.defineProperty(process.stdin, 'isTTY', {
                configurable: true,
                value: originalIsTTY
            })
            consoleLogSpy.mockRestore()
            consoleErrorSpy.mockRestore()
            exitSpy.mockRestore()
        }
    })
})

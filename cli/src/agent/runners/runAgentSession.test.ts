import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    sendSessionDeath: vi.fn(),
    userMessageHandler: null as null | ((message: { content: { text: string; attachments: unknown[] } }, localId: string) => void),
    promptError: null as Error | null,
    cancelPrompt: vi.fn(async () => {}),
    cancelAll: vi.fn(async () => {}),
    stopServer: vi.fn(),
    disconnect: vi.fn(async () => {}),
    prompts: [] as unknown[][],
    startHappyServerOptions: null as unknown,
    bridgeArgs: [] as string[],
    newSessionOptions: null as unknown,
    killHandler: null as null | (() => Promise<void>)
}))

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({
        session: {
            updateAgentState: vi.fn(),
            onUserMessage: vi.fn((handler) => {
                harness.userMessageHandler = handler
            }),
            onCancelQueuedMessage: vi.fn(),
            keepAlive: vi.fn(),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendSessionDeath: harness.sendSessionDeath,
            flush: vi.fn(async () => {}),
            close: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn()
            }
        },
        sessionInfo: {
            permissionMode: 'default'
        }
    }))
}))

vi.mock('@/agent/AgentRegistry', () => ({
    AgentRegistry: {
        create: vi.fn(() => ({
            initialize: vi.fn(async () => {}),
            newSession: vi.fn(async (options: unknown) => {
                harness.newSessionOptions = options
                return 'agent-session-1'
            }),
            prompt: vi.fn(async (_sessionId: string, content: unknown[]) => {
                harness.prompts.push(content)
                if (harness.promptError) {
                    throw harness.promptError
                }
            }),
            cancelPrompt: harness.cancelPrompt,
            respondToPermission: vi.fn(async () => {}),
            onPermissionRequest: vi.fn(),
            disconnect: harness.disconnect
        }))
    }
}))

vi.mock('@/agent/permissionAdapter', () => ({
    PermissionAdapter: vi.fn(function PermissionAdapter() {
        return {
            cancelAll: harness.cancelAll
        }
    })
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async (_session: unknown, options: unknown) => {
        harness.startHappyServerOptions = options
        return {
            url: 'http://127.0.0.1:1234',
            toolNames: ['change_title', 'display_image', 'skill_lookup'],
            stop: harness.stopServer
        }
    })
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: vi.fn((args: string[]) => {
        harness.bridgeArgs = args
        return { command: 'hapi', args, env: [] }
    })
}))

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn((_manager: unknown, handler: () => Promise<void>) => {
        harness.killHandler = handler
    })
}))

vi.mock('@/utils/invokedCwd', () => ({
    getInvokedCwd: vi.fn(() => '/tmp/project')
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn()
    }
}))

vi.mock('@/utils/attachmentFormatter', () => ({
    formatMessageWithAttachments: vi.fn((text: string) => text)
}))

import { runAgentSession } from './runAgentSession'

describe('runAgentSession', () => {
    beforeEach(() => {
        harness.sendSessionDeath.mockClear()
        harness.userMessageHandler = null
        harness.promptError = null
        harness.cancelPrompt.mockClear()
        harness.cancelAll.mockClear()
        harness.stopServer.mockClear()
        harness.disconnect.mockClear()
        harness.prompts = []
        harness.startHappyServerOptions = null
        harness.bridgeArgs = []
        harness.newSessionOptions = null
        harness.killHandler = null
    })

    it('reports unhandled ACP runner failures as error, not completed', async () => {
        harness.cancelAll.mockImplementationOnce(async () => {
            throw new Error('cancel failed')
        })

        const running = runAgentSession({ agentType: 'acp' })
        for (let i = 0; i < 5; i++) {
            await Promise.resolve()
        }
        expect(harness.userMessageHandler).not.toBeNull()
        harness.userMessageHandler?.({ content: { text: 'hello', attachments: [] } }, 'local-1')

        await expect(running).rejects.toThrow('cancel failed')

        expect(harness.sendSessionDeath).toHaveBeenCalledWith('error')
        expect(harness.sendSessionDeath).not.toHaveBeenCalledWith('completed')
    })

    it('enables skill lookup and injects its instruction only on the first prompt', async () => {
        const running = runAgentSession({ agentType: 'acp' })
        await vi.waitFor(() => expect(harness.userMessageHandler).not.toBeNull())

        harness.userMessageHandler?.({ content: { text: 'first', attachments: [] } }, 'local-1')
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(1))
        harness.userMessageHandler?.({ content: { text: 'second', attachments: [] } }, 'local-2')
        await vi.waitFor(() => expect(harness.prompts).toHaveLength(2))

        await harness.killHandler?.()
        await running

        expect(harness.startHappyServerOptions).toEqual({
            skillLookup: {
                workingDirectory: '/tmp/project',
                flavor: 'acp'
            }
        })
        expect(harness.bridgeArgs).toEqual([
            'mcp',
            '--url',
            'http://127.0.0.1:1234',
            '--tools',
            'change_title,display_image,skill_lookup'
        ])
        expect(harness.newSessionOptions).toMatchObject({
            cwd: '/tmp/project',
            mcpServers: [{
                name: 'happy',
                command: 'hapi',
                args: harness.bridgeArgs
            }]
        })

        const firstPrompt = JSON.stringify(harness.prompts[0])
        const secondPrompt = JSON.stringify(harness.prompts[1])
        expect(firstPrompt).toContain('$name')
        expect(firstPrompt).toContain('skill_lookup')
        expect(secondPrompt).not.toContain('skill_lookup')
    })
})

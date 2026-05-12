import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    sendSessionDeath: vi.fn(),
    userMessageHandler: null as null | ((message: { content: { text: string; attachments: unknown[] } }, localId: string) => void),
    promptError: null as Error | null,
    cancelPrompt: vi.fn(async () => {}),
    cancelAll: vi.fn(async () => {}),
    stopServer: vi.fn(),
    disconnect: vi.fn(async () => {})
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
            newSession: vi.fn(async () => 'agent-session-1'),
            prompt: vi.fn(async () => {
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
    startHappyServer: vi.fn(async () => ({
        url: 'http://127.0.0.1:1234',
        stop: harness.stopServer
    }))
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: vi.fn(() => ({ command: 'hapi', args: [], env: [] }))
}))

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn()
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
})

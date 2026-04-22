import { afterEach, describe, expect, it, vi } from 'vitest'
import { RawJSONLinesSchema } from './types'

const harness = {
    replayMessages: [] as Array<Record<string, unknown>>,
    remoteMessages: [] as Array<Record<string, unknown>>,
    scannerCalls: [] as Array<Record<string, unknown>>,
    metadataUpdates: [] as Array<Record<string, unknown>>,
    sessionEvents: [] as Array<Record<string, unknown>>,
    rpcHandlers: new Map<string, (params?: unknown) => Promise<unknown> | unknown>(),
    expectedReplaySessionId: 'resume-session-123',
}

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: {
        onMessage: (message: Record<string, unknown>) => void
    }) => {
        const messages = harness.remoteMessages.length > 0
            ? harness.remoteMessages
            : [{
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'live assistant reply' }]
                }
            }]
        for (const message of messages) {
            opts.onMessage(message)
        }
        queueMicrotask(() => {
            void harness.rpcHandlers.get('switch')?.({})
        })
    }
}))

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: async (opts: {
        sessionId: string | null;
        replayExistingMessages?: boolean;
        onMessage: (message: Record<string, unknown>) => void
    }) => {
        harness.scannerCalls.push(opts as Record<string, unknown>)
        expect(opts.sessionId).toBe(harness.expectedReplaySessionId)
        expect(opts.replayExistingMessages).toBe(true)
        for (const message of harness.replayMessages) {
            const parsed = RawJSONLinesSchema.safeParse(message)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                opts.onMessage(parsed.data)
            }
        }
        return {
            cleanup: async () => {},
            onNewSession: () => {}
        }
    }
}))

vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        constructor() {}
        setOnPermissionRequest(): void {}
        onMessage(): void {}
        getResponses(): Map<string, { approved: boolean }> {
            return new Map()
        }
        handleToolCall(): Promise<{ behavior: 'allow' }> {
            return Promise.resolve({ behavior: 'allow' })
        }
        isAborted(): boolean {
            return false
        }
        handleModeChange(): void {}
        reset(): void {}
    }
}))

vi.mock('./utils/OutgoingMessageQueue', () => ({
    OutgoingMessageQueue: class {
        constructor(private readonly send: (message: Record<string, unknown>) => void) {}
        enqueue(message: Record<string, unknown>): void {
            this.send(message)
        }
        releaseToolCall(): void {}
        async flush(): Promise<void> {}
        destroy(): void {}
    }
}))

vi.mock('@/ui/messageFormatterInk', () => ({
    formatClaudeMessageForInk: () => {}
}))

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => {},
        debugLargeJson: () => {}
    }
}))

import { claudeRemoteLauncher } from './claudeRemoteLauncher'

function createSessionStub() {
    const sentClaudeMessages: Array<Record<string, unknown>> = []
    const sessionFoundCallbacks = new Set<(sessionId: string) => void>()
    let explicitResumeReplayConsumed = false

    const session: {
        sessionId: string | null;
        path: string;
        logPath: string;
        startedBy: 'runner';
        startingMode: 'remote';
        claudeEnvVars: Record<string, string>;
        claudeArgs: string[];
        mcpServers: Record<string, unknown>;
        allowedTools: string[];
        hookSettingsPath: string;
        queue: {
            size: () => number;
            waitForMessagesAndGetAsString: () => Promise<null>;
        };
        client: {
            sendClaudeSessionMessage: (message: Record<string, unknown>) => void;
            sendSessionEvent: (event: Record<string, unknown>) => void;
            updateMetadata: (handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => void;
            rpcHandlerManager: {
                registerHandler: (method: string, handler: (params?: unknown) => Promise<unknown> | unknown) => void;
            };
        };
        addSessionFoundCallback: (callback: (sessionId: string) => void) => void;
        removeSessionFoundCallback: (callback: (sessionId: string) => void) => void;
        onSessionFound: (sessionId: string) => void;
        onThinkingChange: () => void;
        clearSessionId: () => void;
        consumeExplicitRemoteResumeReplaySessionId: () => string | null;
        consumeOneTimeFlags: () => void;
    } = {
        sessionId: null,
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        startedBy: 'runner' as const,
        startingMode: 'remote' as const,
        claudeEnvVars: {},
        claudeArgs: ['--resume', 'resume-session-123'],
        mcpServers: {},
        allowedTools: [],
        hookSettingsPath: '/tmp/hapi-update/hooks.json',
        queue: {
            size: () => 0,
            waitForMessagesAndGetAsString: async () => null,
        },
        client: {
            sendClaudeSessionMessage: (message: Record<string, unknown>) => {
                sentClaudeMessages.push(message)
            },
            sendSessionEvent: (event: Record<string, unknown>) => {
                harness.sessionEvents.push(event)
            },
            updateMetadata: (handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                const next = handler({ summary: null })
                harness.metadataUpdates.push(next)
            },
            rpcHandlerManager: {
                registerHandler(method: string, handler: (params?: unknown) => Promise<unknown> | unknown) {
                    harness.rpcHandlers.set(method, handler)
                }
            }
        },
        addSessionFoundCallback(callback: (sessionId: string) => void) {
            sessionFoundCallbacks.add(callback)
        },
        removeSessionFoundCallback(callback: (sessionId: string) => void) {
            sessionFoundCallbacks.delete(callback)
        },
        onSessionFound(sessionId: string) {
            session.sessionId = sessionId
            session.client.updateMetadata((metadata) => ({
                ...metadata,
                claudeSessionId: sessionId
            }))
            for (const callback of sessionFoundCallbacks) {
                callback(sessionId)
            }
        },
        onThinkingChange: () => {},
        clearSessionId: () => {
            session.sessionId = null
        },
        consumeExplicitRemoteResumeReplaySessionId: () => {
            if (explicitResumeReplayConsumed) {
                return null
            }
            explicitResumeReplayConsumed = true
            return session.claudeArgs[1] ?? null
        },
        consumeOneTimeFlags: () => {},
    }

    return {
        session,
        sentClaudeMessages,
    }
}

describe('claudeRemoteLauncher explicit remote resume replay', () => {
    afterEach(() => {
        harness.replayMessages = []
        harness.remoteMessages = []
        harness.scannerCalls = []
        harness.metadataUpdates = []
        harness.sessionEvents = []
        harness.rpcHandlers = new Map()
        harness.expectedReplaySessionId = 'resume-session-123'
    })

    it('replays transcript history before live remote Claude messages and seeds the imported session id', async () => {
        harness.replayMessages = [
            { type: 'system', subtype: 'init', uuid: 'init-1' },
            { type: 'user', uuid: 'u1', message: { content: 'existing user prompt' } },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'existing assistant reply' }] } },
        ]

        const { session, sentClaudeMessages } = createSessionStub()

        await claudeRemoteLauncher(session as never)

        expect(harness.scannerCalls).toEqual([
            expect.objectContaining({
                sessionId: 'resume-session-123',
                replayExistingMessages: true
            })
        ])
        expect(harness.metadataUpdates).toContainEqual(expect.objectContaining({
            claudeSessionId: 'resume-session-123'
        }))
        expect(sentClaudeMessages[0]).toEqual(expect.objectContaining({
            type: 'user',
            message: expect.objectContaining({ content: 'existing user prompt' })
        }))
        expect(sentClaudeMessages[1]).toEqual(expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
                content: [{ type: 'text', text: 'existing assistant reply' }]
            })
        }))
        expect(sentClaudeMessages.some((message) => {
            const content = (message.message as Record<string, unknown> | undefined)?.content
            return Array.isArray(content)
                && content.some((block) => (block as Record<string, unknown>).text === 'live assistant reply')
        })).toBe(true)
    })

    it('replays transcript history only once for an explicit Claude remote resume session', async () => {
        harness.replayMessages = [
            { type: 'user', uuid: 'u1', message: { content: 'existing user prompt' } },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'existing assistant reply' }] } }
        ]

        const { session, sentClaudeMessages } = createSessionStub()

        await claudeRemoteLauncher(session as never)
        const firstLaunchCount = sentClaudeMessages.length

        await claudeRemoteLauncher(session as never)

        expect(harness.scannerCalls).toHaveLength(1)
        expect(sentClaudeMessages.slice(firstLaunchCount).some((message) => {
            const content = (message.message as Record<string, unknown> | undefined)?.content
            return Array.isArray(content)
                && content.some((block) => (block as Record<string, unknown>).text === 'existing assistant reply')
        })).toBe(false)
    })
})

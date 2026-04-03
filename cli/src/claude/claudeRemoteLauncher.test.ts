import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
    replayMessages: [] as Array<Record<string, unknown>>,
    scannerCalls: [] as Array<Record<string, unknown>>,
    remoteCalls: [] as Array<Record<string, unknown>>,
    rpcHandlers: new Map<string, (params?: unknown) => Promise<unknown> | unknown>(),
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: {
        onMessage: (message: Record<string, unknown>) => void
    }) => {
        harness.remoteCalls.push(opts as Record<string, unknown>)
        opts.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'live assistant reply' }]
            }
        })
        void harness.rpcHandlers.get('switch')?.({})
    }
}))

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: async (opts: {
        onMessage: (message: Record<string, unknown>) => void
    }) => {
        harness.scannerCalls.push(opts as Record<string, unknown>)
        for (const message of harness.replayMessages) {
            opts.onMessage(message)
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
    const sessionEvents: Array<Record<string, unknown>> = []
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
        sessionId: 'resume-session-123',
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
                sessionEvents.push(event)
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
            return 'resume-session-123'
        },
        consumeOneTimeFlags: () => {},
    }

    return {
        session,
        sentClaudeMessages,
        sessionEvents
    }
}

describe('claudeRemoteLauncher', () => {
    afterEach(() => {
        harness.replayMessages = []
        harness.scannerCalls = []
        harness.remoteCalls = []
        harness.rpcHandlers = new Map()
    })

    it('replays transcript history before live remote Claude messages', async () => {
        harness.replayMessages = [
            { type: 'user', uuid: 'u1', message: { content: 'existing user prompt' } },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'existing assistant reply' }] } }
        ]

        const { session, sentClaudeMessages } = createSessionStub()

        await claudeRemoteLauncher(session as never)

        expect(sentClaudeMessages.slice(0, 3)).toEqual([
            expect.objectContaining({
                type: 'user',
                message: expect.objectContaining({ content: 'existing user prompt' })
            }),
            expect.objectContaining({
                type: 'assistant',
                message: expect.objectContaining({
                    content: [{ type: 'text', text: 'existing assistant reply' }]
                })
            }),
            expect.objectContaining({
                type: 'assistant',
                message: expect.objectContaining({
                    content: [{ type: 'text', text: 'live assistant reply' }]
                })
            })
        ])
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
        expect(sentClaudeMessages.slice(firstLaunchCount)).toEqual([
            expect.objectContaining({
                type: 'assistant',
                message: expect.objectContaining({
                    content: [{ type: 'text', text: 'live assistant reply' }]
                })
            })
        ])
    })
})

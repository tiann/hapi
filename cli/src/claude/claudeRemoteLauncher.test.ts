import { afterEach, describe, expect, it, vi } from 'vitest'
import { RawJSONLinesSchema } from './types'

const harness = vi.hoisted(() => ({
    replayMessages: [] as Array<Record<string, unknown>>,
    remoteMessages: [] as Array<Record<string, unknown>>,
    scannerCalls: [] as Array<Record<string, unknown>>,
    remoteCalls: [] as Array<Record<string, unknown>>,
    metadataUpdates: [] as Array<Record<string, unknown>>,
    sessionEvents: [] as Array<Record<string, unknown>>,
    rpcHandlers: new Map<string, (params?: unknown) => Promise<unknown> | unknown>(),
    expectedReplaySessionId: 'resume-session-123',
}))

vi.mock('./claudeRemote', () => ({
    claudeRemote: async (opts: {
        onMessage: (message: Record<string, unknown>) => void
    }) => {
        harness.remoteCalls.push(opts as Record<string, unknown>)
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
        void harness.rpcHandlers.get('switch')?.({})
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
                sessionEvents.push(event)
                harness.sessionEvents.push(event)
            },
            updateMetadata: (handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
                const next = handler({
                    summary: null
                })
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
        sessionEvents
    }
}

describe('claudeRemoteLauncher', () => {
    afterEach(() => {
        harness.replayMessages = []
        harness.remoteMessages = []
        harness.scannerCalls = []
        harness.remoteCalls = []
        harness.metadataUpdates = []
        harness.sessionEvents = []
        harness.rpcHandlers = new Map()
        harness.expectedReplaySessionId = 'resume-session-123'
    })

    it('replays transcript history before live remote Claude messages', async () => {
        harness.replayMessages = [
            { type: 'user', uuid: 'u1', message: { content: 'existing user prompt' } },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'existing assistant reply' }] } }
        ]

        const { session, sentClaudeMessages } = createSessionStub()

        await claudeRemoteLauncher(session as never)

        expect(harness.scannerCalls).toEqual([
            expect.objectContaining({
                sessionId: 'resume-session-123',
                replayExistingMessages: true
            })
        ])
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

    it('forwards Claude subagent metadata from live messages and replayed transcript entries', async () => {
        harness.remoteMessages = [
            {
                type: 'assistant',
                parent_tool_use_id: 'task-1',
                message: {
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: 'task-1',
                        name: 'Task',
                        input: { prompt: 'Investigate test failure' }
                    }]
                }
            },
            {
                type: 'result',
                subtype: 'success',
                result: 'done',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 'task-1'
            }
        ]

        harness.replayMessages = [
            {
                type: 'assistant',
                uuid: 'a1',
                meta: {
                    subagent: {
                        kind: 'title',
                        sidechainKey: 'task-1',
                        title: 'Replay title'
                    }
                },
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'replayed assistant reply' }]
                }
            }
        ]

        const { session, sentClaudeMessages } = createSessionStub()

        await claudeRemoteLauncher(session as never)

        expect(harness.metadataUpdates).toEqual([
            expect.objectContaining({
                summary: expect.objectContaining({
                    text: 'Replay title'
                })
            }),
            expect.objectContaining({
                summary: expect.objectContaining({
                    text: 'Investigate test failure'
                })
            }),
            expect.objectContaining({
                summary: expect.objectContaining({
                    text: 'Investigate test failure'
                })
            })
        ])

        expect(harness.sessionEvents).toContainEqual({
            type: 'subagent_status_change',
            sidechainKey: 'task-1',
            status: 'completed'
        })

        expect(sentClaudeMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'assistant',
                meta: expect.objectContaining({
                    subagent: expect.objectContaining({
                        kind: 'message',
                        sidechainKey: 'task-1'
                    })
                })
            })
        ]))
    })
})

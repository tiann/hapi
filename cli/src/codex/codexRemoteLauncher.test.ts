import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    startThreadIds: [] as string[],
    resumeThreadIds: [] as string[],
    startTurnThreadIds: [] as string[],
    remainingThreadSystemErrors: 0,
    transcriptPathByThreadId: new Map<string, string>(),
    scannerStarts: [] as Array<{ transcriptPath: string | null; replayExistingEvents?: boolean }>,
    scannerCleanups: 0,
    scannerEvents: [] as Array<(event: unknown) => void>
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

        async initialize(params: unknown): Promise<{ protocolVersion: number }> {
            harness.initializeCalls.push(params);
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        async startThread(): Promise<{ thread: { id: string }; model: string }> {
            const id = `thread-${harness.startThreadIds.length + 1}`;
            harness.startThreadIds.push(id);
            return { thread: { id }, model: 'gpt-5.4' };
        }

        async resumeThread(params?: { threadId?: string }): Promise<{ thread: { id: string }; model: string }> {
            const id = params?.threadId ?? 'thread-resumed';
            harness.resumeThreadIds.push(id);
            return { thread: { id }, model: 'gpt-5.4' };
        }

        async startTurn(params?: { threadId?: string }): Promise<{ turn: { id?: string } }> {
            const threadId = params?.threadId ?? 'thread-unknown';
            harness.startTurnThreadIds.push(threadId);
            const turnId = `turn-${harness.startTurnThreadIds.length}`;
            const started = { turn: { id: turnId } };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            if (harness.remainingThreadSystemErrors > 0) {
                harness.remainingThreadSystemErrors -= 1;
                const failed = {
                    thread: { id: threadId },
                    status: { type: 'systemError' }
                };
                harness.notifications.push({ method: 'thread/status/changed', params: failed });
                this.notificationHandler?.('thread/status/changed', failed);
                return { turn: { id: turnId } };
            }

            const completed = { status: 'Completed', turn: { id: turnId } };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: { id: turnId } };
        }

        async interruptTurn(): Promise<Record<string, never>> {
            return {};
        }

        async disconnect(): Promise<void> {}
    }

    return { CodexAppServerClient: MockCodexAppServerClient };
});

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('@/modules/common/codexSessions', () => ({
    findCodexSessionFile: async (threadId: string) => harness.transcriptPathByThreadId.get(threadId) ?? `/tmp/${threadId}.jsonl`
}));

vi.mock('./utils/codexSessionScanner', () => ({
    createCodexSessionScanner: async (opts: {
        transcriptPath: string | null;
        replayExistingEvents?: boolean;
        onEvent: (event: unknown) => void;
    }) => {
        harness.scannerStarts.push({
            transcriptPath: opts.transcriptPath,
            replayExistingEvents: opts.replayExistingEvents
        });
        harness.scannerEvents.push(opts.onEvent);
        return {
            cleanup: async () => {
                harness.scannerCleanups += 1;
            },
            setTranscriptPath: async () => {}
        };
    }
}));

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default',
        collaborationMode: 'default'
    };
}

function createSessionStub(messages = ['hello from launcher test']) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    messages.forEach((message, index) => {
        if (index === 0 && messages.length > 1) {
            queue.pushIsolateAndClear(message, createMode());
        } else {
            queue.push(message, createMode());
        }
    });
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const usagePayloads: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    let currentModel: string | null | undefined;
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        },
        sendAgentMessage(message: unknown) {
            codexMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        }
    };

    const session = {
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        client,
        queue,
        codexArgs: undefined,
        codexCliOverrides: undefined,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(nextModel: string | null) {
            currentModel = nextModel;
        },
        getModel() {
            return currentModel;
        },
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        sendAgentMessage(message: unknown) {
            client.sendAgentMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        },
        recordCodexUsage(payload: unknown) {
            usagePayloads.push(payload);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        rpcHandlers,
        getModel: () => currentModel,
        getAgentState: () => agentState,
        usagePayloads
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.startThreadIds = [];
        harness.resumeThreadIds = [];
        harness.startTurnThreadIds = [];
        harness.remainingThreadSystemErrors = 0;
        harness.transcriptPathByThreadId = new Map();
        harness.scannerStarts = [];
        harness.scannerCleanups = 0;
        harness.scannerEvents = [];
    });

    it('finishes a turn and emits ready when task lifecycle events include turn_id', async () => {
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds,
            getModel
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-1');
        expect(getModel()).toBe('gpt-5.4');
        expect(harness.initializeCalls).toEqual([{
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        }]);
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('surfaces thread-level systemError as a visible failure and emits ready', async () => {
        harness.remainingThreadSystemErrors = 1;
        const { session, sessionEvents } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'thread/status/changed']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Task failed: Codex thread entered systemError'
        });
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(session.thinking).toBe(false);
    });

    it('starts a fresh thread for the next queued message after thread-level systemError', async () => {
        harness.remainingThreadSystemErrors = 1;
        const { session } = createSessionStub(['first message', 'second message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1', 'thread-2']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-2']);
        expect(session.sessionId).toBe('thread-2');
        expect(session.thinking).toBe(false);
    });

    it('tails remote Codex transcript for usage without replaying transcript messages', async () => {
        harness.transcriptPathByThreadId.set('thread-1', '/tmp/codex-thread-1.jsonl');
        const { session, codexMessages, usagePayloads } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.scannerStarts).toEqual([{
            transcriptPath: '/tmp/codex-thread-1.jsonl',
            replayExistingEvents: true
        }]);

        harness.scannerEvents[0]?.({
            type: 'event_msg',
            payload: {
                type: 'token_count',
                info: {
                    total_token_usage: { total_tokens: 42000 },
                    model_context_window: 128000
                }
            }
        });
        harness.scannerEvents[0]?.({
            type: 'event_msg',
            payload: {
                type: 'agent_message',
                message: 'transcript duplicate'
            }
        });

        expect(usagePayloads).toHaveLength(1);
        expect(usagePayloads[0]).toMatchObject({
            type: 'token_count',
            info: {
                total_token_usage: { total_tokens: 42000 },
                model_context_window: 128000
            }
        });
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            message: 'transcript duplicate'
        }));
        expect(harness.scannerCleanups).toBe(1);
    });
});

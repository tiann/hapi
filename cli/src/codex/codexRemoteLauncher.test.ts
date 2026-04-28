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
    interruptedTurns: [] as Array<{ threadId: string; turnId: string }>,
    compactThreadIds: [] as string[],
    suppressTurnCompletion: false,
    remainingThreadSystemErrors: 0
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

            if (harness.suppressTurnCompletion) {
                return { turn: { id: turnId } };
            }

            const completed = { status: 'Completed', turn: { id: turnId } };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: { id: turnId } };
        }

        async interruptTurn(params?: { threadId?: string; turnId?: string }): Promise<Record<string, never>> {
            harness.interruptedTurns.push({
                threadId: params?.threadId ?? 'thread-unknown',
                turnId: params?.turnId ?? 'turn-unknown'
            });
            return {};
        }

        async compactThread(params?: { threadId?: string }): Promise<Record<string, never>> {
            harness.compactThreadIds.push(params?.threadId ?? 'thread-unknown');
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
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    const resetThreadCalls: string[] = [];
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
        resetCodexThread() {
            resetThreadCalls.push(session.sessionId ?? 'none');
            session.sessionId = null;
        },
        sendAgentMessage(message: unknown) {
            client.sendAgentMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        resetThreadCalls,
        rpcHandlers,
        getModel: () => currentModel,
        getAgentState: () => agentState
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
        harness.interruptedTurns = [];
        harness.compactThreadIds = [];
        harness.suppressTurnCompletion = false;
        harness.remainingThreadSystemErrors = 0;
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

    it('clears codex thread state without starting a turn', async () => {
        const { session, sessionEvents, resetThreadCalls } = createSessionStub(['/clear', 'next message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(resetThreadCalls).toEqual(['none']);
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Context was reset'
        });
        expect(session.sessionId).toBe('thread-1');
    });

    it('interrupts an in-flight turn before clearing codex thread state', async () => {
        harness.suppressTurnCompletion = true;
        const { session, sessionEvents, resetThreadCalls } = createSessionStub(['first message', '/clear']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1']);
        expect(harness.interruptedTurns).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
        expect(resetThreadCalls).toEqual(['thread-1']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Context was reset'
        });
        expect(session.thinking).toBe(false);
    });

    it('compacts the current thread without starting a turn', async () => {
        const { session, sessionEvents } = createSessionStub(['first message', '/compact']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1']);
        expect(harness.compactThreadIds).toEqual(['thread-1']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Compaction started'
        });
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Compaction completed'
        });
    });

    it('interrupts an in-flight turn before compacting the current thread', async () => {
        harness.suppressTurnCompletion = true;
        const { session, sessionEvents } = createSessionStub(['first message', '/compact']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1']);
        expect(harness.interruptedTurns).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
        expect(harness.compactThreadIds).toEqual(['thread-1']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Compaction completed'
        });
        expect(session.thinking).toBe(false);
    });

    it('reports nothing to compact when no codex thread exists', async () => {
        const { session, sessionEvents } = createSessionStub(['/compact']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual([]);
        expect(harness.compactThreadIds).toEqual([]);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Nothing to compact'
        });
    });

    it('rejects argument-bearing codex slash commands without starting a turn', async () => {
        const { session, sessionEvents } = createSessionStub(['/compact now']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual([]);
        expect(harness.compactThreadIds).toEqual([]);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: '/compact does not accept arguments'
        });
    });
});

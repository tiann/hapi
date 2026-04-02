import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    extraNotifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    startThreadCalls: [] as unknown[],
    resumeThreadCalls: [] as unknown[],
    startTurnCalls: [] as unknown[],
    startThreadError: null as Error | null,
    resumeThreadError: null as Error | null,
    startTurnError: null as Error | null,
    startThreadResponse: { thread: { id: 'thread-started' }, model: 'gpt-5.4' },
    resumeThreadResponse: { thread: { id: 'thread-resumed' }, model: 'gpt-5.4' }
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

        async startThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.startThreadCalls.push(params);
            if (harness.startThreadError) {
                throw harness.startThreadError;
            }
            return harness.startThreadResponse;
        }

        async resumeThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.resumeThreadCalls.push(params);
            if (harness.resumeThreadError) {
                throw harness.resumeThreadError;
            }
            return harness.resumeThreadResponse;
        }

        async startTurn(params: unknown): Promise<{ turn: Record<string, never> }> {
            harness.startTurnCalls.push(params);
            if (harness.startTurnError) {
                throw harness.startTurnError;
            }
            const started = { turn: {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            const completed = { status: 'Completed', turn: {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            for (const notification of harness.extraNotifications) {
                harness.notifications.push(notification);
                this.notificationHandler?.(notification.method, notification.params);
            }

            return { turn: {} };
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

function createSessionStub(overrides?: { sessionId?: string | null }) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push('hello from launcher test', createMode());
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
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
        sessionId: overrides?.sessionId ?? null,
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
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.extraNotifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.startThreadCalls = [];
        harness.resumeThreadCalls = [];
        harness.startTurnCalls = [];
        harness.startThreadError = null;
        harness.resumeThreadError = null;
        harness.startTurnError = null;
        harness.startThreadResponse = { thread: { id: 'thread-started' }, model: 'gpt-5.4' };
        harness.resumeThreadResponse = { thread: { id: 'thread-resumed' }, model: 'gpt-5.4' };
    });

    it('uses resumeThread only for explicit remote resume success', async () => {
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds,
            getModel
        } = createSessionStub({ sessionId: 'resume-thread-123' });

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.resumeThreadCalls).toHaveLength(1);
        expect(harness.resumeThreadCalls[0]).toMatchObject({ threadId: 'resume-thread-123' });
        expect(harness.startThreadCalls).toEqual([]);
        expect(foundSessionIds).toContain('thread-resumed');
        expect(getModel()).toBe('gpt-5.4');
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('does not report explicit resume failure when resume succeeds but turn startup fails', async () => {
        harness.startTurnError = new Error('turn start failed');
        const {
            session,
            sessionEvents,
            foundSessionIds,
            getModel,
            thinkingChanges
        } = createSessionStub({ sessionId: 'resume-thread-123' });

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.resumeThreadCalls).toHaveLength(1);
        expect(harness.startThreadCalls).toEqual([]);
        expect(harness.startTurnCalls).toHaveLength(1);
        expect(foundSessionIds).toEqual(['thread-resumed']);
        expect(getModel()).toBe('gpt-5.4');
        expect(sessionEvents).toContainEqual({ type: 'message', message: 'Process exited unexpectedly' });
        expect(sessionEvents).not.toContainEqual({
            type: 'message',
            message: 'Explicit remote resume failed for thread resume-thread-123'
        });
        expect(thinkingChanges).toEqual([false]);
        expect(session.thinking).toBe(false);
    });

    it('surfaces explicit remote resume failure without startThread fallback', async () => {
        harness.resumeThreadError = new Error('resume failed hard');
        const {
            session,
            sessionEvents,
            foundSessionIds,
            getModel,
            thinkingChanges
        } = createSessionStub({ sessionId: 'resume-thread-123' });

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.resumeThreadCalls).toHaveLength(1);
        expect(harness.startThreadCalls).toEqual([]);
        expect(foundSessionIds).toEqual([]);
        expect(getModel()).toBeUndefined();
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Explicit remote resume failed for thread resume-thread-123'
        });
        expect(thinkingChanges).toEqual([false]);
        expect(session.thinking).toBe(false);
    });

    it('starts a new thread for non-resume sessions and preserves lifecycle signals', async () => {
        const {
            session,
            sessionEvents,
            foundSessionIds,
            getModel,
            thinkingChanges
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.initializeCalls).toEqual([{
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        }]);
        expect(harness.resumeThreadCalls).toEqual([]);
        expect(harness.startThreadCalls).toHaveLength(1);
        expect(foundSessionIds).toContain('thread-started');
        expect(getModel()).toBe('gpt-5.4');
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('promotes nested parent_tool_call_id from exec command payloads into top-level sidechain metadata', async () => {
        harness.extraNotifications = [
            {
                method: 'item/completed',
                params: {
                    threadId: 'parent-thread',
                    item: {
                        id: 'spawn-1',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        receiverThreadIds: ['child-thread-1']
                    }
                }
            },
            {
                method: 'item/started',
                params: {
                    threadId: 'child-thread-1',
                    item: {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        command: 'ls'
                    }
                }
            },
            {
                method: 'item/completed',
                params: {
                    threadId: 'child-thread-1',
                    item: {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        exitCode: 0
                    }
                }
            }
        ];

        const { session, codexMessages } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'tool-call',
                name: 'CodexBash',
                isSidechain: true,
                parentToolCallId: 'spawn-1'
            }),
            expect.objectContaining({
                type: 'tool-call-result',
                isSidechain: true,
                parentToolCallId: 'spawn-1'
            })
        ]));
    });
});

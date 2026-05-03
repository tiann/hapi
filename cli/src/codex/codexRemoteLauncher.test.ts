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
    remainingThreadSystemErrors: 0,
    startTurnMessages: [] as string[],
    failResumeThreadIds: [] as string[],
    nextThreadSystemErrorMessage: null as string | null,
    failNextCompact: false,
    deferThreadStatusNotifications: false
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
            if (harness.failResumeThreadIds.includes(id)) {
                throw new Error('resume failed');
            }
            return { thread: { id }, model: 'gpt-5.4' };
        }

        async compactThread(params?: { threadId?: string }): Promise<Record<string, never>> {
            const threadId = params?.threadId ?? 'thread-unknown';
            harness.compactThreadIds.push(threadId);
            if (harness.failNextCompact) {
                harness.failNextCompact = false;
                throw new Error('compact failed');
            }
            const compacted = { threadId, turnId: `compact-${harness.compactThreadIds.length}` };
            harness.notifications.push({ method: 'thread/compacted', params: compacted });
            this.notificationHandler?.('thread/compacted', compacted);
            return {};
        }

        async startTurn(params?: { threadId?: string; input?: Array<{ text?: string }>; message?: string; userMessage?: string }): Promise<{ turn: { id?: string } }> {
            const threadId = params?.threadId ?? 'thread-unknown';
            harness.startTurnThreadIds.push(threadId);
            harness.startTurnMessages.push(params?.input?.[0]?.text ?? params?.message ?? params?.userMessage ?? '');
            const turnId = `turn-${harness.startTurnThreadIds.length}`;
            const started = { turn: { id: turnId } };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            if (harness.remainingThreadSystemErrors > 0) {
                harness.remainingThreadSystemErrors -= 1;
                const failed = {
                    thread: { id: threadId },
                    status: { type: 'systemError', ...(harness.nextThreadSystemErrorMessage ? { message: harness.nextThreadSystemErrorMessage } : {}) }
                };
                harness.notifications.push({ method: 'thread/status/changed', params: failed });
                const notify = () => this.notificationHandler?.('thread/status/changed', failed);
                if (harness.deferThreadStatusNotifications) {
                    setTimeout(notify, 0);
                } else {
                    notify();
                }
                return { turn: { id: turnId } };
            }

            if (harness.suppressTurnCompletion) {
                return { turn: { id: turnId } };
            }

            if (params?.threadId === 'thread-1') {
                const commandStart = {
                    item: {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        command: 'echo ok',
                        cwd: '/tmp/hapi-update'
                    }
                };
                harness.notifications.push({ method: 'item/started', params: commandStart });
                this.notificationHandler?.('item/started', commandStart);
                this.notificationHandler?.('item/commandExecution/outputDelta', {
                    itemId: 'cmd-1',
                    delta: 'ok\n'
                });
                const commandEnd = {
                    item: {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        exitCode: 0
                    }
                };
                harness.notifications.push({ method: 'item/completed', params: commandEnd });
                this.notificationHandler?.('item/completed', commandEnd);
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
        harness.startTurnMessages = [];
        harness.failResumeThreadIds = [];
        harness.remainingThreadSystemErrors = 0;
        harness.nextThreadSystemErrorMessage = null;
        harness.failNextCompact = false;
        harness.deferThreadStatusNotifications = false;
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
        expect(harness.notifications.map((entry) => entry.method)).toEqual([
            'turn/started',
            'item/started',
            'item/completed',
            'turn/completed'
        ]);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('surfaces thread-level systemError only after same-thread retries are exhausted', async () => {
        harness.remainingThreadSystemErrors = 4;
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1', 'thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message', 'first message', 'first message']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Task failed: Codex thread entered systemError'
        });
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(session.thinking).toBe(false);
    });

    it('retries a thread-level systemError on the same thread without starting a fresh thread', async () => {
        harness.remainingThreadSystemErrors = 1;
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message']);
        expect(session.sessionId).toBe('thread-1');
        expect(sessionEvents).not.toContainEqual({
            type: 'message',
            message: 'Task failed: Codex thread entered systemError'
        });
        expect(session.thinking).toBe(false);
    });

    it('compacts the same thread before retrying context-window overflow', async () => {
        harness.remainingThreadSystemErrors = 1;
        harness.nextThreadSystemErrorMessage = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.compactThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message']);
        expect(session.sessionId).toBe('thread-1');
        expect(sessionEvents).not.toContainEqual({
            type: 'message',
            message: "Task failed: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
        });
        expect(session.thinking).toBe(false);
    });

    it('retries asynchronous thread-level systemError notifications on the same thread', async () => {
        harness.remainingThreadSystemErrors = 1;
        harness.deferThreadStatusNotifications = true;
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message']);
        expect(session.sessionId).toBe('thread-1');
        expect(sessionEvents).not.toContainEqual({
            type: 'message',
            message: 'Task failed: Codex thread entered systemError'
        });
        expect(session.thinking).toBe(false);
    });

    it('compacts before retrying asynchronous context-window overflow notifications', async () => {
        harness.remainingThreadSystemErrors = 1;
        harness.deferThreadStatusNotifications = true;
        harness.nextThreadSystemErrorMessage = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.compactThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message']);
        expect(session.sessionId).toBe('thread-1');
        expect(sessionEvents).not.toContainEqual({
            type: 'message',
            message: "Task failed: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
        });
        expect(session.thinking).toBe(false);
    });

    it('does not create a new thread when same-conversation compact fails', async () => {
        harness.remainingThreadSystemErrors = 1;
        harness.nextThreadSystemErrorMessage = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
        harness.failNextCompact = true;
        const { session, sessionEvents } = createSessionStub(['first message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.compactThreadIds).toEqual(['thread-1']);
        expect(harness.startTurnThreadIds).toEqual(['thread-1']);
        expect(session.sessionId).toBe('thread-1');
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Task failed: context window overflow and same-conversation compact failed'
        });
        expect(session.thinking).toBe(false);
    });

    it('keeps using the old thread for later messages after same-thread retries are exhausted', async () => {
        harness.remainingThreadSystemErrors = 4;
        const { session } = createSessionStub(['first message', 'second message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1', 'thread-1', 'thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message', 'first message', 'first message', 'second message']);
        expect(session.sessionId).toBe('thread-1');
        expect(session.thinking).toBe(false);
    });

    it('does not create a new thread when an existing conversation cannot be resumed', async () => {
        harness.failResumeThreadIds = ['thread-old'];
        const { session, sessionEvents } = createSessionStub(['first message']);
        session.sessionId = 'thread-old';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.resumeThreadIds).toEqual(['thread-old']);
        expect(harness.startThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual([]);
        expect(session.sessionId).toBe('thread-old');
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Task failed: Codex conversation thread-old could not be resumed; no new conversation was created'
        });
        expect(session.thinking).toBe(false);
    });

    it('does not start a fresh thread for the next queued message after thread-level systemError', async () => {
        harness.remainingThreadSystemErrors = 1;
        const { session } = createSessionStub(['first message', 'second message']);

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadIds).toEqual(['thread-1']);
        expect(harness.resumeThreadIds).toEqual([]);
        expect(harness.startTurnThreadIds).toEqual(['thread-1', 'thread-1', 'thread-1']);
        expect(harness.startTurnMessages).toEqual(['first message', 'first message', 'second message']);
        expect(session.sessionId).toBe('thread-1');
        expect(session.thinking).toBe(false);
    });

    it('surfaces Codex bash stdout instead of duplicating raw output json', async () => {
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'cmd-1',
            output: expect.objectContaining({
                command: 'echo ok',
                cwd: '/tmp/hapi-update',
                stdout: 'ok\n',
                exit_code: 0
            })
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'cmd-1',
            output: expect.objectContaining({
                output: 'ok\n'
            })
        }));
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

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
    deferThreadStatusNotifications: false,
    emitChildThreadEvents: false,
    emitChildUsageEvents: false,
    emitChildReasoningBurst: false,
    emitParentUsageEvents: false,
    emitChildNestedAgentTool: false,
    emitParentTitleChange: false,
    emitParentSpawnFailureWithoutAgentId: false,
    emitParentSpawnStartWithoutEnd: false,
    emitParentSendInputFailure: false,
    emitParentResumeSuccess: false,
    bridgeOptions: [] as unknown[]
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
                if (harness.emitParentTitleChange) {
                    const titleStart = {
                        item: {
                            id: 'title-parent',
                            type: 'mcpToolCall',
                            server: 'hapi',
                            tool: 'change_title',
                            arguments: { title: 'Parent Title' }
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/started', params: titleStart });
                    this.notificationHandler?.('item/started', titleStart);

                    const titleEnd = {
                        item: {
                            id: 'title-parent',
                            type: 'mcpToolCall',
                            server: 'hapi',
                            tool: 'change_title',
                            result: {
                                content: [
                                    { type: 'text', text: 'Successfully changed chat title to: "Parent Title"' }
                                ]
                            }
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/completed', params: titleEnd });
                    this.notificationHandler?.('item/completed', titleEnd);
                }

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

                if (harness.emitParentUsageEvents) {
                    const parentUsage = {
                        tokenUsage: {
                            thread_id: threadId,
                            turn_id: turnId,
                            last_token_usage: {
                                input_tokens: 100,
                                output_tokens: 10
                            },
                            model_context_window: 200_000
                        }
                    };
                    harness.notifications.push({ method: 'thread/tokenUsage/updated', params: parentUsage });
                    this.notificationHandler?.('thread/tokenUsage/updated', parentUsage);

                    const parentCompact = { thread: { id: threadId } };
                    harness.notifications.push({ method: 'thread/compacted', params: parentCompact });
                    this.notificationHandler?.('thread/compacted', parentCompact);
                }

                if (harness.emitParentSpawnFailureWithoutAgentId || harness.emitParentSpawnStartWithoutEnd) {
                    const spawnStart = {
                        item: {
                            id: 'failed-spawn',
                            type: 'collabAgentToolCall',
                            tool: 'spawnAgent',
                            prompt: 'do side work',
                            reasoningEffort: 'medium',
                            senderThreadId: threadId,
                            receiverThreadIds: []
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/started', params: spawnStart });
                    this.notificationHandler?.('item/started', spawnStart);

                    if (harness.emitParentSpawnFailureWithoutAgentId) {
                        const spawnCompleted = {
                            item: {
                                id: 'failed-spawn',
                                type: 'collabAgentToolCall',
                                tool: 'spawnAgent',
                                status: 'failed',
                                error: 'invalid spawn arguments',
                                senderThreadId: threadId,
                                receiverThreadIds: [],
                                agentsStates: {}
                            },
                            threadId,
                            turnId
                        };
                        harness.notifications.push({ method: 'item/completed', params: spawnCompleted });
                        this.notificationHandler?.('item/completed', spawnCompleted);
                    }
                }
            }

            if (harness.emitChildThreadEvents) {
                const childThreadId = 'child-thread';
                const childTurnId = 'child-turn';
                const childMessage = 'child output should stay hidden';

                if (harness.emitChildReasoningBurst) {
                    for (let i = 0; i < 20; i += 1) {
                        const reasoningDelta = {
                            msg: {
                                type: 'reasoning_content_delta',
                                item_id: 'child-reasoning',
                                delta: `step-${i} `,
                                thread_id: childThreadId,
                                turn_id: childTurnId
                            }
                        };
                        harness.notifications.push({ method: 'codex/event/reasoning_content_delta', params: reasoningDelta });
                        this.notificationHandler?.('codex/event/reasoning_content_delta', reasoningDelta);
                    }
                }

                const childMessageCompleted = {
                    item: {
                        id: 'child-msg-1',
                        type: 'agentMessage',
                        content: [{ type: 'text', text: childMessage }]
                    },
                    threadId: childThreadId,
                    turnId: childTurnId
                };
                harness.notifications.push({ method: 'item/completed', params: childMessageCompleted });
                this.notificationHandler?.('item/completed', childMessageCompleted);

                if (harness.emitChildUsageEvents) {
                    const childUsage = {
                        tokenUsage: {
                            thread_id: childThreadId,
                            turn_id: childTurnId,
                            last_token_usage: {
                                input_tokens: 30,
                                output_tokens: 3
                            },
                            model_context_window: 200_000
                        }
                    };
                    harness.notifications.push({ method: 'thread/tokenUsage/updated', params: childUsage });
                    this.notificationHandler?.('thread/tokenUsage/updated', childUsage);

                    const childCompact = {
                        msg: {
                            type: 'context_compacted',
                            thread_id: childThreadId,
                            turn_id: childTurnId
                        }
                    };
                    harness.notifications.push({ method: 'codex/event/context_compacted', params: childCompact });
                    this.notificationHandler?.('codex/event/context_compacted', childCompact);

                    const ambiguousUsage = {
                        tokenUsage: {
                            last_token_usage: {
                                input_tokens: 999,
                                output_tokens: 1
                            }
                        }
                    };
                    harness.notifications.push({ method: 'thread/tokenUsage/updated', params: ambiguousUsage });
                    this.notificationHandler?.('thread/tokenUsage/updated', ambiguousUsage);
                }

                const childCommandStart = {
                    item: {
                        id: 'child-cmd-1',
                        type: 'commandExecution',
                        command: 'echo child'
                    },
                    threadId: childThreadId,
                    turnId: childTurnId
                };
                harness.notifications.push({ method: 'item/started', params: childCommandStart });
                this.notificationHandler?.('item/started', childCommandStart);
                this.notificationHandler?.('item/commandExecution/outputDelta', {
                    itemId: 'child-cmd-1',
                    delta: 'child stdout\n',
                    threadId: childThreadId,
                    turnId: childTurnId
                });
                const childCommandEnd = {
                    item: {
                        id: 'child-cmd-1',
                        type: 'commandExecution',
                        exitCode: 0
                    },
                    threadId: childThreadId,
                    turnId: childTurnId
                };
                harness.notifications.push({ method: 'item/completed', params: childCommandEnd });
                this.notificationHandler?.('item/completed', childCommandEnd);

                const childTitleStart = {
                    item: {
                        id: 'title-child',
                        type: 'mcpToolCall',
                        server: 'hapi',
                        tool: 'change_title',
                        arguments: { title: 'Child Title' }
                    },
                    threadId: childThreadId,
                    turnId: childTurnId
                };
                harness.notifications.push({ method: 'item/started', params: childTitleStart });
                this.notificationHandler?.('item/started', childTitleStart);

                const childTitleEnd = {
                    item: {
                        id: 'title-child',
                        type: 'mcpToolCall',
                        server: 'hapi',
                        tool: 'change_title',
                        result: {
                            content: [
                                { type: 'text', text: 'Successfully changed chat title to: "Child Title"' }
                            ]
                        }
                    },
                    threadId: childThreadId,
                    turnId: childTurnId
                };
                harness.notifications.push({ method: 'item/completed', params: childTitleEnd });
                this.notificationHandler?.('item/completed', childTitleEnd);

                if (harness.emitChildNestedAgentTool) {
                    const nestedSpawnStart = {
                        item: {
                            id: 'nested-spawn',
                            type: 'collabAgentToolCall',
                            tool: 'spawn',
                            senderThreadId: childThreadId,
                            receiverThreadIds: ['grandchild-thread'],
                            prompt: 'do nested work'
                        },
                        threadId: childThreadId,
                        turnId: childTurnId
                    };
                    harness.notifications.push({ method: 'item/started', params: nestedSpawnStart });
                    this.notificationHandler?.('item/started', nestedSpawnStart);

                    const nestedSpawnCompleted = {
                        item: {
                            id: 'nested-spawn',
                            type: 'collabAgentToolCall',
                            tool: 'spawn',
                            status: 'completed',
                            senderThreadId: childThreadId,
                            receiverThreadIds: ['grandchild-thread'],
                            agentsStates: {}
                        },
                        threadId: childThreadId,
                        turnId: childTurnId
                    };
                    harness.notifications.push({ method: 'item/completed', params: nestedSpawnCompleted });
                    this.notificationHandler?.('item/completed', nestedSpawnCompleted);
                }

                const waitStarted = {
                    item: {
                        id: 'wait-child',
                        type: 'collabAgentToolCall',
                        tool: 'wait',
                        senderThreadId: threadId,
                        receiverThreadIds: [childThreadId],
                        agentsStates: {}
                    },
                    threadId,
                    turnId
                };
                harness.notifications.push({ method: 'item/started', params: waitStarted });
                this.notificationHandler?.('item/started', waitStarted);

                const waitCompleted = {
                    item: {
                        id: 'wait-child',
                        type: 'collabAgentToolCall',
                        tool: 'wait',
                        status: 'completed',
                        senderThreadId: threadId,
                        receiverThreadIds: [childThreadId],
                        agentsStates: {
                            [childThreadId]: {
                                status: 'completed',
                                message: childMessage
                            }
                        }
                    },
                    threadId,
                    turnId
                };
                harness.notifications.push({ method: 'item/completed', params: waitCompleted });
                this.notificationHandler?.('item/completed', waitCompleted);

                if (harness.emitParentSendInputFailure) {
                    const sendInputStarted = {
                        item: {
                            id: 'send-child',
                            type: 'collabAgentToolCall',
                            tool: 'sendInput',
                            senderThreadId: threadId,
                            receiverThreadIds: [childThreadId],
                            message: 'follow up'
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/started', params: sendInputStarted });
                    this.notificationHandler?.('item/started', sendInputStarted);

                    const sendInputCompleted = {
                        item: {
                            id: 'send-child',
                            type: 'collabAgentToolCall',
                            tool: 'sendInput',
                            status: 'failed',
                            error: 'send failed',
                            senderThreadId: threadId,
                            receiverThreadIds: [childThreadId],
                            agentsStates: {}
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/completed', params: sendInputCompleted });
                    this.notificationHandler?.('item/completed', sendInputCompleted);
                }

                if (harness.emitParentResumeSuccess) {
                    const resumeStarted = {
                        item: {
                            id: 'resume-child',
                            type: 'collabAgentToolCall',
                            tool: 'resumeAgent',
                            senderThreadId: threadId,
                            receiverThreadIds: [childThreadId]
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/started', params: resumeStarted });
                    this.notificationHandler?.('item/started', resumeStarted);

                    const resumeCompleted = {
                        item: {
                            id: 'resume-child',
                            type: 'collabAgentToolCall',
                            tool: 'resumeAgent',
                            status: 'completed',
                            senderThreadId: threadId,
                            receiverThreadIds: [childThreadId],
                            agentsStates: {}
                        },
                        threadId,
                        turnId
                    };
                    harness.notifications.push({ method: 'item/completed', params: resumeCompleted });
                    this.notificationHandler?.('item/completed', resumeCompleted);
                }
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
    buildHapiMcpBridge: async (_client: unknown, options?: unknown) => {
        harness.bridgeOptions.push(options);
        return {
        server: {
            stop: () => {}
        },
        mcpServers: {}
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
    const summaryMessages: unknown[] = [];
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
        sendClaudeSessionMessage(message: unknown) {
            summaryMessages.push(message);
        },
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
        summaryMessages,
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
        harness.emitChildThreadEvents = false;
        harness.emitChildUsageEvents = false;
        harness.emitChildReasoningBurst = false;
        harness.emitParentUsageEvents = false;
        harness.emitChildNestedAgentTool = false;
        harness.emitParentTitleChange = false;
        harness.emitParentSpawnFailureWithoutAgentId = false;
        harness.emitParentSpawnStartWithoutEnd = false;
        harness.emitParentSendInputFailure = false;
        harness.emitParentResumeSuccess = false;
        harness.bridgeOptions = [];
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

    it('routes child thread messages into agent-run trace while keeping them out of the parent timeline', async () => {
        harness.emitChildThreadEvents = true;
        const { session, codexMessages, summaryMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'child output should stay hidden'
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'tool-call',
            callId: 'child-cmd-1'
        }));
        expect(summaryMessages).not.toContainEqual(expect.objectContaining({
            type: 'summary',
            summary: 'Child Title'
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'wait_agent',
            callId: 'wait-child'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-trace',
            agentId: 'child-thread',
            message: expect.objectContaining({
                type: 'message',
                message: 'child output should stay hidden'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-trace',
            agentId: 'child-thread',
            message: expect.objectContaining({
                type: 'tool-call',
                callId: 'child-cmd-1'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            activity: 'Running command: echo child',
            activityKind: 'running-command'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            summary: 'Child Title'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'completed',
            result: 'child output should stay hidden',
            activity: 'Completed: child output should stay hidden',
            activityKind: 'completed'
        }));
    });

    it('surfaces send_input failures on the target child agent card', async () => {
        harness.emitChildThreadEvents = true;
        harness.emitParentSendInputFailure = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'running',
            statusText: 'Sending input',
            activity: 'Sending input',
            activityKind: 'send_input'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'failed',
            statusText: 'Send input failed',
            activity: 'Send input failed: send failed',
            activityKind: 'failed',
            error: expect.objectContaining({
                error: 'send failed'
            })
        }));
    });

    it('updates the target child agent card when resume_agent completes', async () => {
        harness.emitChildThreadEvents = true;
        harness.emitParentResumeSuccess = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'running',
            statusText: 'Resuming agent',
            activity: 'Resuming agent',
            activityKind: 'resume_agent'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'running',
            statusText: 'Resumed',
            activity: 'Resumed',
            activityKind: 'resume_agent',
            result: expect.objectContaining({
                status: 'completed',
                targets: ['child-thread']
            })
        }));
    });

    it('throttles child agent reasoning activity updates instead of emitting one per delta', async () => {
        harness.emitChildThreadEvents = true;
        harness.emitChildReasoningBurst = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        const thinkingUpdates = codexMessages.filter((message): message is Record<string, unknown> => {
            return typeof message === 'object'
                && message !== null
                && (message as Record<string, unknown>).type === 'agent-run-update'
                && (message as Record<string, unknown>).agentId === 'child-thread'
                && (message as Record<string, unknown>).activityKind === 'thinking';
        });

        expect(thinkingUpdates.length).toBeLessThan(20);
        expect(thinkingUpdates.length).toBeLessThanOrEqual(1);
    });

    it('keeps child usage and compact events out of the parent context stream', async () => {
        harness.emitChildThreadEvents = true;
        harness.emitChildUsageEvents = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'token_count',
            thread_id: 'child-thread'
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'token_count',
            info: expect.objectContaining({
                last_token_usage: expect.objectContaining({
                    input_tokens: 999
                })
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-trace',
            agentId: 'child-thread',
            message: expect.objectContaining({
                type: 'context_compacted'
            })
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'context_compacted',
            thread_id: 'child-thread'
        }));
    });

    it('marks parent usage and compact events with parent scope', async () => {
        harness.emitParentUsageEvents = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'token_count',
            thread_id: 'thread-1',
            scope_role: 'parent',
            scope: expect.objectContaining({
                role: 'parent',
                thread_id: 'thread-1'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'context_compacted',
            thread_id: 'thread-1',
            scope_role: 'parent',
            scope: expect.objectContaining({
                role: 'parent',
                thread_id: 'thread-1'
            })
        }));
    });

    it('marks child agents failed when they attempt to start nested agents', async () => {
        harness.emitChildThreadEvents = true;
        harness.emitChildNestedAgentTool = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-trace',
            agentId: 'child-thread',
            message: expect.objectContaining({
                type: 'tool-call',
                name: 'spawn_agent',
                callId: 'nested-spawn'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-trace',
            agentId: 'child-thread',
            message: expect.objectContaining({
                type: 'tool-call-result',
                callId: 'nested-spawn',
                is_error: true,
                output: 'Nested agent calls are disabled for child agents.'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'child-thread',
            status: 'failed',
            activity: 'Failed: Nested agent calls are disabled for child agents.',
            activityKind: 'failed'
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'grandchild-thread'
        }));
    });

    it('marks spawn_agent cards failed when Codex returns no agent id', async () => {
        harness.emitParentSpawnFailureWithoutAgentId = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-start',
            cardId: 'failed-spawn',
            status: 'starting'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'spawn-error:failed-spawn',
            cardId: 'failed-spawn',
            status: 'failed',
            statusText: 'Failed to start',
            activityKind: 'failed',
            error: expect.objectContaining({
                status: 'failed',
                error: 'invalid spawn arguments'
            })
        }));
    });

    it('marks pending spawn_agent cards failed when the session ends before a result', async () => {
        harness.emitParentSpawnStartWithoutEnd = true;
        const { session, codexMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-start',
            cardId: 'failed-spawn',
            status: 'starting'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'agent-run-update',
            agentId: 'spawn-error:failed-spawn',
            cardId: 'failed-spawn',
            status: 'failed',
            statusText: 'Failed to start',
            activityKind: 'failed',
            error: 'spawn_agent did not return an agent id before the Codex session ended'
        }));
    });

    it('applies parent-thread hapi change_title after disabling MCP-side title writes', async () => {
        harness.emitParentTitleChange = true;
        const { session, codexMessages, summaryMessages } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(harness.bridgeOptions).toEqual([{ emitTitleSummary: false }]);
        expect(summaryMessages).toContainEqual(expect.objectContaining({
            type: 'summary',
            summary: 'Parent Title'
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'mcp__hapi__change_title',
            callId: 'title-parent',
            input: { title: 'Parent Title' }
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'title-parent',
            is_error: false
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

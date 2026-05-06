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
    emitChildThreadEvents: false,
    emitChildUsageEvents: false,
    emitParentUsageEvents: false,
    emitChildNestedAgentTool: false,
    emitParentTitleChange: false,
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
            }

            if (harness.emitChildThreadEvents) {
                const childThreadId = 'child-thread';
                const childTurnId = 'child-turn';
                const childMessage = 'child output should stay hidden';

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
        harness.remainingThreadSystemErrors = 0;
        harness.emitChildThreadEvents = false;
        harness.emitChildUsageEvents = false;
        harness.emitParentUsageEvents = false;
        harness.emitChildNestedAgentTool = false;
        harness.emitParentTitleChange = false;
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

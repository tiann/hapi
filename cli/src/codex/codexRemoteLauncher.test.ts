import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    startThreadCalls: [] as unknown[],
    startTurnCalls: [] as unknown[],
    steerCalls: [] as unknown[],
    interruptCalls: [] as unknown[],
    compactCalls: [] as unknown[],
    goalGetCalls: [] as unknown[],
    goalSetCalls: [] as unknown[],
    goalClearCalls: [] as unknown[],
    goalGetResponse: null as null | { goal: unknown },
    goalError: null as Error | null,
    resumeError: null as Error | null,
    mcpExtraTools: [] as Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }>,
    afterTurnStarted: null as null | (() => Promise<void> | void),
    deferInterruptCompletion: false,
    resolveDeferredInterrupt: null as null | (() => void),
    interruptError: null as Error | null,
    latestNotificationHandler: null as null | ((method: string, params: unknown) => void),
    emitTurnStartedDuringGoalSet: false,
    emitTurnStartedAfterGoalSet: false,
    compactError: null as Error | null,
    deferCompactCompletion: false,
    deferCompactFailure: false,
    emitDeferredCompactCompletion: null as null | (() => void),
    emitDeferredCompactFailure: null as null | (() => void),
    turnCompletion: { status: 'Completed' } as { status: string; message?: string },
    turnScripts: [] as Array<{
        startedTurnId?: string;
        responseTurnId?: string;
        completionTurnId?: string;
        extraStartedTurnIdBeforeCompletion?: string;
        advanceBeforeCompletionMs?: number;
    }>,
    titleSyncCalls: [] as string[],
    nowMs: 1_700_000_000_000,
    advanceBeforeTurnCompleteMs: 0,
    emitContextCompactionBeforeCompletion: false,
    emitLargeToolOutputBeforeCompletion: false,
    emitLargeMcpOutputBeforeCompletion: false,
    emitCodexSubagentLifecycleBeforeCompletion: false,
    emitAutoContextCompactionBeforeCompletion: false,
    delayAfterAutoContextCompactionMs: 0
}));

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerError extends Error {
        readonly code?: number;
        readonly writeState: 'not-written' | 'written';

        constructor(options: { message: string; code?: number; writeState: 'not-written' | 'written' }) {
            super(options.message);
            this.code = options.code;
            this.writeState = options.writeState;
        }
    }

    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

        async initialize(params: unknown): Promise<{ protocolVersion: number }> {
            harness.initializeCalls.push(params);
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
            harness.latestNotificationHandler = handler;
        }

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        async startThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.startThreadCalls.push(params);
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(): Promise<{ thread: { id: string }; model: string }> {
            if (harness.resumeError) throw harness.resumeError;
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(params: unknown): Promise<{ turn: Record<string, unknown> }> {
            harness.startTurnCalls.push(params);
            const script = harness.turnScripts.shift();
            const started = { turn: script?.startedTurnId ? { id: script.startedTurnId } : {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);
            await harness.afterTurnStarted?.();

            if (script?.extraStartedTurnIdBeforeCompletion) {
                const extraStarted = { turn: { id: script.extraStartedTurnIdBeforeCompletion } };
                harness.notifications.push({ method: 'turn/started', params: extraStarted });
                this.notificationHandler?.('turn/started', extraStarted);
            }

            if (harness.emitContextCompactionBeforeCompletion) {
                const compacted = {
                    threadId: 'thread-anonymous',
                    previousTokens: 120000,
                    tokens: 25000
                };
                harness.notifications.push({ method: 'thread/compacted', params: compacted });
                this.notificationHandler?.('thread/compacted', compacted);
            }

            if (harness.emitLargeToolOutputBeforeCompletion) {
                const completedCommand = {
                    item: {
                        type: 'commandExecution',
                        id: 'cmd-large',
                        output: `head\n${'x'.repeat(25_000)}\ntail`,
                        exitCode: 0,
                        status: 'completed'
                    }
                };
                harness.notifications.push({ method: 'item/completed', params: completedCommand });
                this.notificationHandler?.('item/completed', completedCommand);
            }

            if (harness.emitLargeMcpOutputBeforeCompletion) {
                const startedMcp = {
                    msg: {
                        type: 'mcp_tool_call_begin',
                        call_id: 'mcp-large',
                        invocation: {
                            server: 'browser',
                            tool: 'open',
                            arguments: { url: 'http://localhost' }
                        }
                    }
                };
                const completedMcp = {
                    msg: {
                        type: 'mcp_tool_call_end',
                        call_id: 'mcp-large',
                        result: { Ok: `head\n${'m'.repeat(25_000)}\ntail` }
                    }
                };
                harness.notifications.push({ method: 'codex/event/mcp_tool_call_begin', params: startedMcp });
                this.notificationHandler?.('codex/event/mcp_tool_call_begin', startedMcp);
                harness.notifications.push({ method: 'codex/event/mcp_tool_call_end', params: completedMcp });
                this.notificationHandler?.('codex/event/mcp_tool_call_end', completedMcp);
            }

            if (harness.emitCodexSubagentLifecycleBeforeCompletion) {
                const spawnCall = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'call-spawn',
                        item: {
                            id: 'call-spawn',
                            type: 'function_call',
                            namespace: 'multi_agent_v1',
                            name: 'spawn_agent',
                            call_id: 'call-spawn',
                            arguments: JSON.stringify({
                                agent_type: 'default',
                                message: 'Review the HAPI diff'
                            })
                        }
                    }
                };
                const spawnOutput = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'out-spawn',
                        item: {
                            id: 'out-spawn',
                            type: 'function_call_output',
                            call_id: 'call-spawn',
                            output: JSON.stringify({
                                agent_id: 'agent-1',
                                nickname: 'Boyle'
                            })
                        }
                    }
                };
                harness.notifications.push({ method: 'codex/event/item_completed', params: spawnCall });
                this.notificationHandler?.('codex/event/item_completed', spawnCall);
                harness.notifications.push({ method: 'codex/event/item_completed', params: spawnOutput });
                this.notificationHandler?.('codex/event/item_completed', spawnOutput);

                const waitCall = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'call-wait',
                        item: {
                            id: 'call-wait',
                            type: 'function_call',
                            namespace: 'multi_agent_v1',
                            name: 'wait_agent',
                            call_id: 'call-wait',
                            arguments: JSON.stringify({
                                targets: ['agent-1'],
                                timeout_ms: 30000
                            })
                        }
                    }
                };
                const waitOutput = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'out-wait',
                        item: {
                            id: 'out-wait',
                            type: 'function_call_output',
                            call_id: 'call-wait',
                            output: JSON.stringify({
                                status: {},
                                timed_out: true
                            })
                        }
                    }
                };
                const closeCall = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'call-close',
                        item: {
                            id: 'call-close',
                            type: 'function_call',
                            namespace: 'multi_agent_v1',
                            name: 'close_agent',
                            call_id: 'call-close',
                            arguments: JSON.stringify({ target: 'agent-1' })
                        }
                    }
                };
                const closeOutput = {
                    msg: {
                        type: 'item_completed',
                        item_id: 'out-close',
                        item: {
                            id: 'out-close',
                            type: 'function_call_output',
                            call_id: 'call-close',
                            output: JSON.stringify({
                                previous_status: { completed: 'Done.' }
                            })
                        }
                    }
                };
                harness.notifications.push({ method: 'codex/event/item_completed', params: waitCall });
                this.notificationHandler?.('codex/event/item_completed', waitCall);
                harness.notifications.push({ method: 'codex/event/item_completed', params: waitOutput });
                this.notificationHandler?.('codex/event/item_completed', waitOutput);
                harness.notifications.push({ method: 'codex/event/item_completed', params: closeCall });
                this.notificationHandler?.('codex/event/item_completed', closeCall);
                harness.notifications.push({ method: 'codex/event/item_completed', params: closeOutput });
                this.notificationHandler?.('codex/event/item_completed', closeOutput);
            }

            if (harness.emitAutoContextCompactionBeforeCompletion) {
                const compacted = {
                    msg: {
                        type: 'context_compacted',
                        thread_id: 'thread-anonymous'
                    }
                };
                harness.notifications.push({ method: 'codex/event/context_compacted', params: compacted });
                this.notificationHandler?.('codex/event/context_compacted', compacted);

                if (harness.delayAfterAutoContextCompactionMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, harness.delayAfterAutoContextCompactionMs));
                }
            }

            harness.nowMs += script?.advanceBeforeCompletionMs ?? harness.advanceBeforeTurnCompleteMs;
            const completed = {
                ...harness.turnCompletion,
                turn: script?.completionTurnId ? { id: script.completionTurnId } : {}
            };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: script?.responseTurnId ? { id: script.responseTurnId } : {} };
        }

        async steerTurn(params: unknown): Promise<{ turnId: string }> {
            harness.steerCalls.push(params);
            const expectedTurnId = typeof params === 'object' && params && 'expectedTurnId' in params
                ? String((params as { expectedTurnId: unknown }).expectedTurnId)
                : 'turn-live';
            return { turnId: expectedTurnId };
        }

        async interruptTurn(params: unknown): Promise<Record<string, never>> {
            harness.interruptCalls.push(params);
            if (harness.deferInterruptCompletion) {
                await new Promise<void>((resolve) => {
                    harness.resolveDeferredInterrupt = resolve;
                });
            }
            if (harness.interruptError) throw harness.interruptError;
            return {};
        }

        async compactThread(params: unknown): Promise<Record<string, never>> {
            harness.compactCalls.push(params);
            if (harness.compactError) {
                throw harness.compactError;
            }
            if (harness.deferCompactCompletion) {
                const started = {
                    threadId: 'thread-anonymous',
                    item: {
                        type: 'contextCompaction',
                        id: 'compact-delayed'
                    }
                };
                this.notificationHandler?.('item/started', started);
                harness.emitDeferredCompactCompletion = () => {
                    const completed = {
                        threadId: 'thread-anonymous',
                        item: {
                            type: 'contextCompaction',
                            id: 'compact-delayed'
                        }
                    };
                    this.notificationHandler?.('item/completed', completed);
                };
                return {};
            }
            if (harness.deferCompactFailure) {
                const started = {
                    threadId: 'thread-anonymous',
                    item: {
                        type: 'contextCompaction',
                        id: 'compact-failed'
                    }
                };
                this.notificationHandler?.('item/started', started);
                harness.emitDeferredCompactFailure = () => {
                    const failed = {
                        status: 'Failed',
                        message: 'compact failed asynchronously',
                        turn: {}
                    };
                    this.notificationHandler?.('turn/completed', failed);
                };
                return {};
            }
            this.notificationHandler?.('thread/compacted', { threadId: 'thread-anonymous' });
            return {};
        }

        async getThreadGoal(params: unknown): Promise<{ goal: unknown }> {
            harness.goalGetCalls.push(params);
            if (harness.goalError) {
                throw harness.goalError;
            }
            return harness.goalGetResponse ?? { goal: null };
        }

        async setThreadGoal(params: unknown): Promise<{ goal: unknown }> {
            harness.goalSetCalls.push(params);
            if (harness.goalError) {
                throw harness.goalError;
            }
            if (harness.emitTurnStartedDuringGoalSet) {
                this.notificationHandler?.('thread/goal/updated', {
                    threadId: 'thread-anonymous',
                    turnId: null,
                    goal: {
                        threadId: 'thread-anonymous',
                        objective: 'from notification',
                        status: 'active',
                        tokenBudget: null,
                        tokensUsed: 0,
                        timeUsedSeconds: 0,
                        createdAt: 1,
                        updatedAt: 2
                    }
                });
                this.notificationHandler?.('turn/started', { turn: { id: 'goal-side-turn' } });
                this.notificationHandler?.('turn/completed', { turn: { id: 'goal-side-turn' }, status: 'Completed' });
            }
            if (harness.emitTurnStartedAfterGoalSet) {
                setTimeout(() => {
                    this.notificationHandler?.('turn/started', { turn: { id: 'goal-delayed-turn' } });
                }, 0);
            }
            return {
                goal: {
                    threadId: 'thread-anonymous',
                    objective: (params as { objective?: string }).objective ?? '',
                    status: 'active',
                    tokenBudget: null,
                    tokensUsed: 0,
                    timeUsedSeconds: 0,
                    createdAt: 1,
                    updatedAt: 2
                }
            };
        }

        async clearThreadGoal(params: unknown): Promise<{ cleared: boolean }> {
            harness.goalClearCalls.push(params);
            if (harness.goalError) {
                throw harness.goalError;
            }
            this.notificationHandler?.('thread/goal/cleared', { threadId: 'thread-anonymous' });
            return { cleared: true };
        }

        async disconnect(): Promise<void> {}
    }

    return {
        CodexAppServerClient: MockCodexAppServerClient,
        CodexAppServerError: MockCodexAppServerError,
        formatCodexAppServerFailure: (error: unknown) => `Codex request failed: ${error instanceof Error ? error.message : String(error)}`
    };
});

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async (_client: unknown, options?: { extraTools?: typeof harness.mcpExtraTools }) => {
        harness.registerRequestCalls.push(`mcp-tools:${options?.extraTools?.length ?? 0}`);
        harness.mcpExtraTools = options?.extraTools ?? [];
        return {
        server: {
            stop: () => {}
        },
        mcpServers: {}
        };
    }
}));

vi.mock('./utils/codexThreadTitle', () => ({
    createCodexThreadTitlePoller: () => ({ stop: () => {} }),
    syncCodexThreadTitleToMetadata: async (_client: unknown, threadId: string) => {
        harness.titleSyncCalls.push(threadId);
        return true;
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

function createSessionStub(initialMessage: string | string[] = 'hello from launcher test') {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    const messages = Array.isArray(initialMessage) ? initialMessage : [initialMessage];
    for (const message of messages) {
        queue.push(message, createMode());
    }
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    let currentModel: string | null | undefined;
    let currentModelReasoningEffort: string | null | undefined;
    let currentServiceTier: string | null | undefined;
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
        isDesktopMirrorSession() {
            return false;
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
        setModelReasoningEffort(nextModelReasoningEffort: string | null) {
            currentModelReasoningEffort = nextModelReasoningEffort;
        },
        getModelReasoningEffort() {
            return currentModelReasoningEffort;
        },
        setServiceTier(nextServiceTier: string | null) {
            currentServiceTier = nextServiceTier;
        },
        getServiceTier() {
            return currentServiceTier;
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
        invalidateQueuedMessages: vi.fn(async () => {}),
        onAmbiguousDelivery: vi.fn()
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.startThreadCalls = [];
        harness.startTurnCalls = [];
        harness.steerCalls = [];
        harness.interruptCalls = [];
        harness.compactCalls = [];
        harness.goalGetCalls = [];
        harness.goalSetCalls = [];
        harness.goalClearCalls = [];
        harness.goalGetResponse = null;
        harness.goalError = null;
        harness.resumeError = null;
        harness.mcpExtraTools = [];
        harness.afterTurnStarted = null;
        harness.deferInterruptCompletion = false;
        harness.resolveDeferredInterrupt = null;
        harness.interruptError = null;
        harness.latestNotificationHandler = null;
        harness.emitTurnStartedDuringGoalSet = false;
        harness.emitTurnStartedAfterGoalSet = false;
        harness.compactError = null;
        harness.deferCompactCompletion = false;
        harness.deferCompactFailure = false;
        harness.emitDeferredCompactCompletion = null;
        harness.emitDeferredCompactFailure = null;
        harness.turnCompletion = { status: 'Completed' };
        harness.turnScripts = [];
        harness.titleSyncCalls = [];
        harness.nowMs = 1_700_000_000_000;
        harness.advanceBeforeTurnCompleteMs = 0;
        harness.emitContextCompactionBeforeCompletion = false;
        harness.emitLargeToolOutputBeforeCompletion = false;
        harness.emitLargeMcpOutputBeforeCompletion = false;
        harness.emitCodexSubagentLifecycleBeforeCompletion = false;
        harness.emitAutoContextCompactionBeforeCompletion = false;
        harness.delayAfterAutoContextCompactionMs = 0;
        vi.restoreAllMocks();
    });

    it('finishes a turn and emits ready when task lifecycle events omit turn_id', async () => {
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds,
            getModel
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-anonymous');
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

    it('does not silently start a new thread when a runner recovery resume fails', async () => {
        const { session, sessionEvents } = createSessionStub();
        const runnerSession = session as typeof session & { startedBy: 'runner' };
        runnerSession.startedBy = 'runner';
        runnerSession.sessionId = 'recorded-thread';
        harness.resumeError = new Error('native resume failed');

        const exitReason = await codexRemoteLauncher(runnerSession as never);

        expect(exitReason).toBe('exit');
        expect(harness.startThreadCalls).toHaveLength(0);
        expect(harness.startTurnCalls).toHaveLength(0);
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('native resume failed')
        }));
    });

    it('syncs the Codex desktop thread title when a HAPI runner thread is known and after the turn settles', async () => {
        const { session } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(harness.titleSyncCalls).toContain('thread-anonymous');
        expect(harness.titleSyncCalls.length).toBeGreaterThanOrEqual(3);
    });

    it('persists failed terminal events so the hub can notify for attention', async () => {
        harness.turnCompletion = { status: 'Failed', message: 'boom' };
        const {
            session,
            codexMessages
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'task_failed',
            error: 'Codex task failed'
        }));
    });

    it('persists native context compaction notifications without ending the turn', async () => {
        harness.emitContextCompactionBeforeCompletion = true;
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'context_compacted',
            thread_id: 'thread-anonymous',
            previousTokens: 120000,
            tokens: 25000
        }));
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(1);
    });

    it('summarizes oversized command outputs before sending them to HAPI', async () => {
        harness.emitLargeToolOutputBeforeCompletion = true;
        const {
            session,
            codexMessages
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'cmd-large',
            output: expect.objectContaining({
                type: 'hapi-tool-output-summary',
                truncated: true,
                callId: 'cmd-large',
                toolName: 'CodexBash',
                preview: expect.stringContaining('head')
            })
        }));
    });

    it('keeps MCP tool identity when summarizing oversized MCP outputs', async () => {
        harness.emitLargeMcpOutputBeforeCompletion = true;
        const {
            session,
            codexMessages
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'mcp-large',
            output: expect.objectContaining({
                type: 'hapi-tool-output-summary',
                truncated: true,
                callId: 'mcp-large',
                toolName: 'mcp__browser__open'
            })
        }));
    });

    it('persists Codex subagent lifecycle calls for HAPI team tracking', async () => {
        harness.emitCodexSubagentLifecycleBeforeCompletion = true;
        const {
            session,
            codexMessages
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'spawn_agent',
            callId: 'call-spawn',
            input: expect.objectContaining({
                agent_id: 'agent-1',
                nickname: 'Boyle',
                agent_type: 'default',
                message: 'Review the HAPI diff'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'call-spawn',
            output: expect.objectContaining({
                agent_id: 'agent-1',
                nickname: 'Boyle'
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'wait_agent',
            callId: 'call-wait',
            input: expect.objectContaining({
                targets: ['agent-1'],
                status: {}
            })
        }));
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'close_agent',
            callId: 'call-close',
            input: expect.objectContaining({
                target: 'agent-1',
                previous_status: { completed: 'Done.' }
            })
        }));
    });

    it('emits a HAPI-only turn-duration event after a Codex turn settles', async () => {
        harness.advanceBeforeTurnCompleteMs = 12_345;
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        const {
            session,
            sessionEvents
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(sessionEvents).toContainEqual(expect.objectContaining({
            type: 'turn-duration',
            durationMs: 12_345
        }));
    });

    it('does not let an ignored mismatched terminal event inflate a later turn duration', async () => {
        harness.turnScripts = [
            {
                startedTurnId: 'stale-turn',
                extraStartedTurnIdBeforeCompletion: 'overlapping-turn',
                responseTurnId: 'overlapping-turn',
                completionTurnId: 'stale-turn',
                advanceBeforeCompletionMs: 100_000
            },
            {
                startedTurnId: 'fresh-turn',
                responseTurnId: 'fresh-turn',
                completionTurnId: 'fresh-turn',
                advanceBeforeCompletionMs: 12_000
            }
        ];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        const {
            session,
            sessionEvents
        } = createSessionStub();
        let waits = 0;
        (session as any).queue = {
            size() {
                return waits < 2 ? 1 : 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString() {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: 'first prompt',
                        mode: createMode(),
                        isolate: false,
                        hash: 'first'
                    };
                }
                if (waits === 2) {
                    return {
                        message: 'second prompt',
                        mode: createMode(),
                        isolate: false,
                        hash: 'second'
                    };
                }
                return null;
            }
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        const durations = sessionEvents
            .filter((event) => event.type === 'turn-duration')
            .map((event) => event.durationMs);
        expect(durations.at(-1)).toBe(12_000);
        expect(durations).toHaveLength(1);
        expect(durations).not.toContain(112_000);
    });

    it('does not resurrect a completed turn id from the startTurn response', async () => {
        harness.turnScripts = [{
            startedTurnId: 'completed-before-response',
            responseTurnId: 'completed-before-response',
            completionTurnId: 'completed-before-response',
            advanceBeforeCompletionMs: 1_000
        }];
        const {
            session,
            sessionEvents,
            rpcHandlers
        } = createSessionStub();
        let waits = 0;
        (session as any).queue = {
            size() {
                return waits === 0 ? 1 : 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString(signal?: AbortSignal) {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: 'complete before response',
                        mode: createMode(),
                        isolate: false,
                        hash: 'first'
                    };
                }
                await new Promise<void>((resolve) => {
                    if (signal?.aborted) {
                        resolve();
                        return;
                    }
                    signal?.addEventListener('abort', () => resolve(), { once: true });
                });
                return null;
            }
        };

        const launcherPromise = codexRemoteLauncher(session as never);

        await waitForCondition(() => sessionEvents.some((event) => event.type === 'ready'));
        await rpcHandlers.get('switch')?.({});
        const exitReason = await launcherPromise;

        expect(exitReason).toBe('switch');
        expect(harness.interruptCalls).toEqual([]);
    });

    it('does not emit ready for automatic context compaction before the turn completes', async () => {
        harness.emitAutoContextCompactionBeforeCompletion = true;
        harness.delayAfterAutoContextCompactionMs = 200;
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'context_compacted',
            thread_id: 'thread-anonymous'
        }));
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(1);
    });

    it('does not live-append queued messages after abort even if a late turn_started arrives before cleanup', async () => {
        harness.turnScripts = [{
            startedTurnId: 'active-turn',
            responseTurnId: 'active-turn',
            completionTurnId: 'active-turn'
        }];
        const { session, rpcHandlers } = createSessionStub();
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        session.queue = queue;
        queue.push('initial prompt', createMode());
        let pushedAfterAbort = false;
        harness.afterTurnStarted = async () => {
            if (pushedAfterAbort) return;
            pushedAfterAbort = true;
            await rpcHandlers.get('switch')?.({});
            harness.latestNotificationHandler?.('turn/started', { turn: { id: 'late-turn-after-abort' } });
            queue.push('late follow-up after abort', createMode());
            queue.close();
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('switch');
        expect(harness.steerCalls).toEqual([]);
    });

    it('does not report abort completion when durable queue cancellation fails', async () => {
        const { session, rpcHandlers } = createSessionStub();
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        session.queue = queue;
        session.invalidateQueuedMessages.mockRejectedValueOnce(new Error('durable cancel failed'));

        const launcher = codexRemoteLauncher(session as never);
        await waitForCondition(() => rpcHandlers.has('abort'));
        const abort = rpcHandlers.get('abort')?.({});
        queue.push('must remain quarantined after failed abort', createMode());
        queue.close();
        await expect(abort).rejects.toThrow('durable cancel failed');
        await expect(launcher).resolves.toBe('exit');
        expect(session.onAmbiguousDelivery).toHaveBeenCalledOnce();
        expect(queue.size()).toBe(1);
        expect(harness.startTurnCalls).toHaveLength(0);
    });

    it('waits for an in-flight abort before reusing the queue without spinning', async () => {
        harness.deferInterruptCompletion = true;
        harness.turnScripts = [
            {
                startedTurnId: 'turn-before-abort',
                responseTurnId: 'turn-before-abort',
                completionTurnId: 'turn-before-abort'
            },
            {
                startedTurnId: 'turn-after-abort',
                responseTurnId: 'turn-after-abort',
                completionTurnId: 'turn-after-abort'
            }
        ];
        const { session, rpcHandlers } = createSessionStub();
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        session.queue = queue;
        queue.push('initial prompt', createMode());

        const originalWait = queue.waitForMessagesAndReserve.bind(queue);
        let abortedWaitCalls = 0;
        vi.spyOn(queue, 'waitForMessagesAndReserve').mockImplementation(async (signal?: AbortSignal) => {
            if (signal?.aborted) {
                abortedWaitCalls += 1;
                if (abortedWaitCalls > 1) {
                    throw new Error('queue wait spun while abort was still pending');
                }
            }
            return originalWait(signal);
        });

        let abortStarted = false;
        let abortPromise: Promise<unknown> | null = null;
        harness.afterTurnStarted = () => {
            if (abortStarted) return;
            abortStarted = true;
            abortPromise = Promise.resolve(rpcHandlers.get('abort')?.({}));
            setTimeout(() => harness.resolveDeferredInterrupt?.(), 10);
            void abortPromise.then(() => {
                queue.push('follow-up after abort', createMode());
                queue.close();
            });
        };

        const exitReason = await codexRemoteLauncher(session as never);
        await expect(abortPromise).resolves.toBeUndefined();

        expect(exitReason).toBe('exit');
        expect(abortedWaitCalls).toBe(1);
        expect(harness.interruptCalls).toEqual([{
            threadId: 'thread-anonymous',
            turnId: 'turn-before-abort'
        }]);
        expect(harness.startTurnCalls).toHaveLength(2);
    });

    it('quarantines the session when the native turn cannot be interrupted', async () => {
        harness.interruptError = new Error('interrupt transport timeout');
        harness.turnScripts = [{
            startedTurnId: 'turn-interrupt-fails',
            responseTurnId: 'turn-interrupt-fails',
            completionTurnId: 'turn-interrupt-fails'
        }];
        const { session, rpcHandlers } = createSessionStub();
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        session.queue = queue;
        queue.push('initial prompt', createMode());

        let abortPromise: Promise<unknown> | null = null;
        harness.afterTurnStarted = () => {
            if (abortPromise) return;
            abortPromise = Promise.resolve(rpcHandlers.get('abort')?.({}));
            void abortPromise.finally(() => queue.close()).catch(() => {});
        };

        const exitReason = await codexRemoteLauncher(session as never);
        await expect(abortPromise).rejects.toThrow('interrupt transport timeout');

        expect(exitReason).toBe('exit');
        expect(session.invalidateQueuedMessages).toHaveBeenCalledWith('codex-abort', 'canceled');
        expect(session.onAmbiguousDelivery).toHaveBeenCalledOnce();
        expect(harness.startTurnCalls).toHaveLength(1);
    });

    it('does not commit an in-flight delivery reservation after durable abort cancellation fails', async () => {
        const { session, rpcHandlers } = createSessionStub('must remain quarantined');
        let resolvePrepare!: (value: { written: true }) => void;
        const prepareBatch = vi.fn(() => new Promise<{ written: true }>((resolve) => {
            resolvePrepare = resolve;
        }));
        const recordTerminal = vi.fn().mockResolvedValue(true);
        (session as typeof session & {
            deliveryOutcomes: {
                prepareBatch: typeof prepareBatch;
                recordTerminal: typeof recordTerminal;
            };
        }).deliveryOutcomes = { prepareBatch, recordTerminal };
        session.invalidateQueuedMessages.mockRejectedValueOnce(new Error('durable cancel failed'));

        const launcher = codexRemoteLauncher(session as never);
        await waitForCondition(() => prepareBatch.mock.calls.length === 1 && rpcHandlers.has('abort'));
        const abort = rpcHandlers.get('abort')?.({});
        await expect(abort).rejects.toThrow('durable cancel failed');
        resolvePrepare({ written: true });

        await expect(launcher).resolves.toBe('exit');
        expect(session.queue.size()).toBe(1);
        expect(harness.startThreadCalls).toHaveLength(0);
        expect(harness.startTurnCalls).toHaveLength(0);
    });

    it('live-appends matching normal user pushes into the active Codex turn instead of starting a second turn', async () => {
        harness.turnScripts = [{
            startedTurnId: 'turn-live',
            responseTurnId: 'turn-live',
            completionTurnId: 'turn-live'
        }];
        const { session } = createSessionStub();
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        session.queue = queue;
        queue.push('initial prompt', createMode());
        let pushedFollowUp = false;
        harness.afterTurnStarted = () => {
            if (pushedFollowUp) return;
            pushedFollowUp = true;
            queue.push('follow-up while active', createMode());
            queue.close();
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.steerCalls).toEqual([{
            threadId: 'thread-anonymous',
            expectedTurnId: 'turn-live',
            input: [{ type: 'text', text: 'follow-up while active' }]
        }]);
        expect(harness.startTurnCalls).toHaveLength(1);
    });

    it('runs native Codex compaction for /compact without starting a normal turn', async () => {
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub('/compact');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.compactCalls).toEqual([{ threadId: 'thread-anonymous' }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'context_compacted',
            thread_id: 'thread-anonymous'
        }));
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
    });

    it('sets native Codex goals through app-server without starting a normal turn or leaving thinking stuck', async () => {
        harness.emitTurnStartedDuringGoalSet = true;
        harness.emitTurnStartedAfterGoalSet = true;
        const {
            session,
            codexMessages,
            sessionEvents,
            thinkingChanges
        } = createSessionStub('/goal finish the HAPI goal fix');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(harness.goalSetCalls).toEqual([{
            threadId: 'thread-anonymous',
            objective: 'finish the HAPI goal fix',
            status: 'active'
        }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Goal set: finish the HAPI goal fix'
        }));
        expect(thinkingChanges).not.toContain(true);
        expect(session.thinking).toBe(false);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
    });

    it('clears terminal completed goals before starting a normal turn so native create_goal can be reused', async () => {
        harness.goalGetResponse = {
            goal: {
                threadId: 'thread-anonymous',
                objective: 'old completed goal',
                status: 'complete',
                tokenBudget: null,
                tokensUsed: 42,
                timeUsedSeconds: 7,
                createdAt: 1,
                updatedAt: 2
            }
        };
        const { session, codexMessages } = createSessionStub('please create a new long goal');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.goalGetCalls).toContainEqual({ threadId: 'thread-anonymous' });
        expect(harness.goalClearCalls).toEqual([{ threadId: 'thread-anonymous' }]);
        expect(harness.startTurnCalls).toHaveLength(1);
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            message: expect.stringContaining('Goal cleared')
        }));
    });

    it('suppresses goal MCP side-effect turn notifications during an active Codex turn', async () => {
        harness.emitTurnStartedDuringGoalSet = true;
        harness.turnScripts = [{
            startedTurnId: 'main-turn',
            responseTurnId: 'main-turn',
            completionTurnId: 'main-turn',
            advanceBeforeCompletionMs: 12_345
        }];
        vi.spyOn(Date, 'now').mockImplementation(() => harness.nowMs);
        harness.afterTurnStarted = async () => {
            const setGoal = harness.mcpExtraTools.find((tool) => tool.name === 'set_goal');
            expect(setGoal).toBeDefined();
            await setGoal!.handler({ objective: 'goal from MCP' });
        };
        const {
            session,
            sessionEvents
        } = createSessionStub('normal turn that uses HAPI set_goal');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.goalSetCalls).toContainEqual({
            threadId: 'thread-anonymous',
            objective: 'goal from MCP',
            status: 'active'
        });
        const durations = sessionEvents
            .filter((event) => event.type === 'turn-duration')
            .map((event) => event.durationMs);
        expect(durations).toEqual([12_345]);
    });

    it('renders the current native Codex goal objective from app-server get response', async () => {
        harness.goalGetResponse = {
            goal: {
                threadId: 'thread-anonymous',
                objective: 'keep working until verified',
                status: 'usageLimited',
                tokenBudget: null,
                tokensUsed: 42,
                timeUsedSeconds: 7,
                createdAt: 1,
                updatedAt: 2
            }
        };
        const {
            session,
            codexMessages
        } = createSessionStub('/goal');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.goalGetCalls).toEqual([{ threadId: 'thread-anonymous' }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('keep working until verified')
        }));
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            message: expect.stringContaining('[object Object]')
        }));
    });

    it('clears native Codex goals through app-server without starting a normal turn', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub('/goal clear');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.goalClearCalls).toEqual([{ threadId: 'thread-anonymous' }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Goal cleared'
        }));
    });

    it('reports older Codex app-server versions that lack native goal RPCs', async () => {
        harness.goalError = new Error('method not found: thread/goal/set');
        const {
            session,
            codexMessages
        } = createSessionStub('/goal finish the HAPI goal fix');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.goalSetCalls).toEqual([{
            threadId: 'thread-anonymous',
            objective: 'finish the HAPI goal fix',
            status: 'active'
        }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'task_failed',
            error: 'Your version of Codex does not support the native /goal command. Please update Codex.'
        }));
    });

    it('keeps /compact in flight until the compaction completion event arrives', async () => {
        harness.deferCompactCompletion = true;
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub('/compact');
        session.sessionId = 'thread-anonymous';

        let waits = 0;
        let releaseIdleWait: (() => void) | null = null;
        session.queue = {
            size() {
                return 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString() {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: '/compact',
                        mode: createMode(),
                        isolate: true,
                        hash: 'hash-compact'
                    };
                }
                await new Promise<void>((resolve) => {
                    releaseIdleWait = resolve;
                });
                return null;
            }
        } as never;

        const launcherPromise = codexRemoteLauncher(session as never);

        await waitForCondition(() => harness.compactCalls.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(waits).toBe(1);
        expect(harness.startTurnCalls).toEqual([]);
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(0);
        expect(codexMessages).not.toContainEqual(expect.objectContaining({
            type: 'context_compacted'
        }));

        harness.emitDeferredCompactCompletion?.();
        await waitForCondition(() => sessionEvents.some((event) => event.type === 'ready'));
        (releaseIdleWait as (() => void) | null)?.();

        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(waits).toBe(2);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'context_compacted'
        }));
    });

    it('does not process queued follow-up text until /compact completes', async () => {
        harness.deferCompactCompletion = true;
        const {
            session,
            sessionEvents
        } = createSessionStub('/compact');
        session.sessionId = 'thread-anonymous';

        let waits = 0;
        session.queue = {
            size() {
                return waits < 2 ? 1 : 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString() {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: '/compact',
                        mode: createMode(),
                        isolate: true,
                        hash: 'hash-compact'
                    };
                }
                if (waits === 2) {
                    return {
                        message: 'after compact',
                        mode: createMode(),
                        isolate: false,
                        hash: 'hash-follow-up'
                    };
                }
                return null;
            }
        } as never;

        const launcherPromise = codexRemoteLauncher(session as never);

        await waitForCondition(() => harness.compactCalls.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(waits).toBe(1);
        expect(harness.startTurnCalls).toEqual([]);
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(0);

        harness.emitDeferredCompactCompletion?.();

        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(harness.startTurnCalls).toHaveLength(1);
        expect(harness.startTurnCalls[0]).toMatchObject({
            input: [{ type: 'text', text: 'after compact' }]
        });
    });

    it('uses the latest session reasoning effort and service tier when starting a turn', async () => {
        const { session } = createSessionStub();
        (session as any).getModelReasoningEffort = () => 'high';
        (session as any).getServiceTier = () => 'fast';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.startTurnCalls[0]).toMatchObject({
            effort: 'high',
            serviceTier: 'fast'
        });
    });

    it('reports /compact failures without starting a normal turn', async () => {
        harness.compactError = new Error('compact unavailable');
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub('/compact');
        session.sessionId = 'thread-anonymous';

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.compactCalls).toEqual([{ threadId: 'thread-anonymous' }]);
        expect(harness.startTurnCalls).toEqual([]);
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'task_failed',
            error: 'Compaction failed: Codex request failed: compact unavailable'
        }));
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
    });

    it('settles /compact when an asynchronous failure event arrives', async () => {
        harness.deferCompactFailure = true;
        const {
            session,
            codexMessages,
            sessionEvents
        } = createSessionStub('/compact');
        session.sessionId = 'thread-anonymous';

        let waits = 0;
        let releaseIdleWait: (() => void) | null = null;
        session.queue = {
            size() {
                return 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString() {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: '/compact',
                        mode: createMode(),
                        isolate: true,
                        hash: 'hash-compact-fail'
                    };
                }
                await new Promise<void>((resolve) => {
                    releaseIdleWait = resolve;
                });
                return null;
            }
        } as never;

        const launcherPromise = codexRemoteLauncher(session as never);

        await waitForCondition(() => harness.compactCalls.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(sessionEvents.filter((event) => event.type === 'ready')).toHaveLength(0);

        harness.emitDeferredCompactFailure?.();
        await waitForCondition(() => sessionEvents.some((event) => event.type === 'ready'));
        (releaseIdleWait as (() => void) | null)?.();

        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'task_failed',
            error: 'Codex task failed'
        }));
    });

    it('exits after an idle desktop-mirror takeover turn instead of waiting forever for more messages', async () => {
        const {
            session,
            sessionEvents
        } = createSessionStub();
        const desktopMirrorSession = session as any;

        let waits = 0;
        desktopMirrorSession.startedBy = 'runner';
        desktopMirrorSession.client.isDesktopMirrorSession = () => true;
        desktopMirrorSession.queue = {
            size() {
                return waits === 0 ? 1 : 0;
            },
            reset() {},
            async waitForMessagesAndGetAsString() {
                waits += 1;
                if (waits === 1) {
                    return {
                        message: 'desktop mirror follow-up',
                        mode: createMode(),
                        isolate: false,
                        hash: 'hash-1'
                    };
                }
                return await new Promise(() => {});
            }
        };

        const exitReason = await Promise.race([
            codexRemoteLauncher(desktopMirrorSession as never),
            new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250))
        ]);

        expect(exitReason).toBe('exit');
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
    });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    requestHandlers: new Map<string, (params: unknown) => Promise<unknown> | unknown>(),
    initializeCalls: [] as unknown[],
    listCollaborationModeCalls: 0,
    startThreadIds: [] as string[],
    resumeThreadIds: [] as string[],
    startTurnThreadIds: [] as string[],
    startTurnParams: [] as Array<Record<string, unknown>>,
    startTurnErrors: [] as Error[],
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

        async listCollaborationModes(): Promise<{ collaborationModes: Array<{ mode: string }> }> {
            harness.listCollaborationModeCalls += 1;
            return { collaborationModes: [{ mode: 'default' }, { mode: 'plan' }] };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
            harness.registerRequestCalls.push(method);
            harness.requestHandlers.set(method, handler);
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

        async startTurn(params?: { threadId?: string; collaborationMode?: unknown }): Promise<{ turn: { id?: string } }> {
            harness.startTurnParams.push((params ?? {}) as Record<string, unknown>);
            const nextError = harness.startTurnErrors.shift();
            if (nextError) {
                throw nextError;
            }
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

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default',
        collaborationMode: 'default',
        model: 'gpt-5.4'
    };
}

function createSessionStub(messages = ['hello from launcher test'], mode: EnhancedMode = createMode()) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    messages.forEach((message, index) => {
        if (index === 0 && messages.length > 1) {
            queue.pushIsolateAndClear(message, mode);
        } else {
            queue.push(message, mode);
        }
    });
    queue.close();

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    const collaborationModes: Array<EnhancedMode['collaborationMode'] | undefined> = [];
    let currentModel: string | null | undefined = mode.model;
    let currentCollaborationMode: EnhancedMode['collaborationMode'] | undefined = mode.collaborationMode;
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
        getCollaborationMode() {
            return currentCollaborationMode;
        },
        setCollaborationMode(nextMode: EnhancedMode['collaborationMode']) {
            currentCollaborationMode = nextMode;
            collaborationModes.push(nextMode);
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
        getCollaborationMode: () => currentCollaborationMode,
        collaborationModes,
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.requestHandlers = new Map();
        harness.initializeCalls = [];
        harness.listCollaborationModeCalls = 0;
        harness.startThreadIds = [];
        harness.resumeThreadIds = [];
        harness.startTurnThreadIds = [];
        harness.startTurnParams = [];
        harness.startTurnErrors = [];
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

    it('retries plan turns without collaborationMode when the runtime rejects the field', async () => {
        harness.startTurnErrors.push(new Error('unknown field collaborationMode; experimentalApi is required'));
        const { session, sessionEvents } = createSessionStub(['plan this'], {
            permissionMode: 'default',
            collaborationMode: 'plan',
            model: 'gpt-5.4'
        });

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.listCollaborationModeCalls).toBe(1);
        expect(harness.startTurnParams).toHaveLength(2);
        expect(harness.startTurnParams[0]?.collaborationMode).toMatchObject({
            mode: 'plan'
        });
        expect(harness.startTurnParams[1]?.collaborationMode).toBeUndefined();
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Plan mode is not supported by this Codex runtime. Sent as a normal turn instead.'
        });
    });

    it('switches collaboration mode to default after approving exit_plan_mode', async () => {
        const { session, rpcHandlers, collaborationModes, getCollaborationMode } = createSessionStub([], {
            permissionMode: 'default',
            collaborationMode: 'plan',
            model: 'gpt-5.4'
        });

        const exitReasonPromise = codexRemoteLauncher(session as never);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const approvalHandler = harness.requestHandlers.get('item/tool/requestApproval');
        expect(approvalHandler).toBeTypeOf('function');
        const approvalPromise = approvalHandler?.({
            itemId: 'exit-1',
            toolName: 'exit_plan_mode',
            input: { plan: '1. Edit files' }
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');
        await permissionRpc?.({ id: 'exit-1', approved: true, decision: 'approved' });
        await expect(approvalPromise).resolves.toEqual({ decision: 'accept' });

        const exitReason = await exitReasonPromise;

        expect(exitReason).toBe('exit');
        expect(collaborationModes).toContain('default');
        expect(getCollaborationMode()).toBe('default');
    });
});

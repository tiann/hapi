import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    startThreadCalls: [] as unknown[],
    resumeThreadCalls: [] as unknown[],
    startTurnCalls: [] as unknown[],
    steerTurnCalls: [] as unknown[],
    notificationHandler: null as ((method: string, params: unknown) => void) | null,
    disconnectHandler: null as ((error: Error) => void) | null,
    startTurnImpl: null as null | (() => Promise<{ turn: Record<string, unknown> }>),
    steerTurnImpl: null as null | (() => Promise<Record<string, never>>)
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
            harness.notificationHandler = handler;
        }

        registerRequestHandler(method: string): void {
            harness.registerRequestCalls.push(method);
        }

        setDisconnectHandler(handler: ((error: Error) => void) | null): void {
            harness.disconnectHandler = handler;
        }

        async startThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.startThreadCalls.push(params);
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(params: unknown): Promise<{ thread: { id: string }; model: string }> {
            harness.resumeThreadCalls.push(params);
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(): Promise<{ turn: Record<string, never> }> {
            harness.startTurnCalls.push({});
            if (harness.startTurnImpl) {
                return harness.startTurnImpl() as Promise<{ turn: Record<string, never> }>;
            }
            const started = { turn: {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            const completed = { status: 'Completed', turn: {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

            return { turn: {} };
        }

        async steerTurn(params: unknown): Promise<Record<string, never>> {
            harness.steerTurnCalls.push(params);
            if (harness.steerTurnImpl) {
                return harness.steerTurnImpl();
            }
            return {};
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

function createSessionStub(options?: { closeQueue?: boolean }) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    queue.push('hello from launcher test', createMode());
    if (options?.closeQueue ?? true) {
        queue.close();
    }

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

function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (condition()) {
                resolve();
                return;
            }
            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error('Timed out waiting for condition'));
                return;
            }
            setTimeout(tick, 10);
        };
        tick();
    });
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.startThreadCalls = [];
        harness.resumeThreadCalls = [];
        harness.startTurnCalls = [];
        harness.steerTurnCalls = [];
        harness.notificationHandler = null;
        harness.disconnectHandler = null;
        harness.startTurnImpl = null;
        harness.steerTurnImpl = null;
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

    it('does not start a second turn while the first turn is still active', async () => {
        harness.startTurnImpl = async () => {
            const started = { turn: { id: 'turn-1' } };
            harness.notifications.push({ method: 'turn/started', params: started });
            harness.notificationHandler?.('turn/started', started);
            return { turn: { id: 'turn-1' } };
        };

        const { session, sessionEvents, thinkingChanges } = createSessionStub({ closeQueue: false });
        const launcherPromise = codexRemoteLauncher(session as never);

        await waitFor(() => harness.startTurnCalls.length === 1);

        session.queue.push('second message', createMode());
        session.queue.close();

        await waitFor(() => harness.steerTurnCalls.length === 1);
        expect(harness.startTurnCalls).toHaveLength(1);

        const completed = { status: 'Completed', turn: { id: 'turn-1' } };
        harness.notifications.push({ method: 'turn/completed', params: completed });
        harness.notificationHandler?.('turn/completed', completed);

        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(harness.startTurnCalls).toHaveLength(1);
        expect(harness.steerTurnCalls).toHaveLength(1);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('steers queued messages once the active turn id becomes known', async () => {
        let releaseTurnStart!: () => void;
        harness.startTurnImpl = async () => {
            await new Promise<void>((resolve) => {
                releaseTurnStart = resolve;
            });
            return { turn: { id: 'turn-late-id' } };
        };

        const { session, sessionEvents, thinkingChanges } = createSessionStub({ closeQueue: false });
        const launcherPromise = codexRemoteLauncher(session as never);

        await waitFor(() => harness.startTurnCalls.length === 1);

        session.queue.push('second message before turn id', createMode());
        session.queue.close();
        expect(harness.steerTurnCalls).toHaveLength(0);

        releaseTurnStart();
        await waitFor(() => harness.steerTurnCalls.length === 1);
        expect(harness.startTurnCalls).toHaveLength(1);

        const completed = { status: 'Completed', turn: { id: 'turn-late-id' } };
        harness.notifications.push({ method: 'turn/completed', params: completed });
        harness.notificationHandler?.('turn/completed', completed);

        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(harness.startTurnCalls).toHaveLength(1);
        expect(harness.steerTurnCalls).toHaveLength(1);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).not.toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('re-establishes thread lifecycle after disconnecting during an active turn', async () => {
        let turnStarts = 0;
        harness.startTurnImpl = async () => {
            turnStarts += 1;
            const turnId = `turn-${turnStarts}`;
            const started = { turn: { id: turnId } };
            harness.notifications.push({ method: 'turn/started', params: started });
            harness.notificationHandler?.('turn/started', started);

            if (turnStarts === 2) {
                const completed = { status: 'Completed', turn: { id: turnId } };
                harness.notifications.push({ method: 'turn/completed', params: completed });
                harness.notificationHandler?.('turn/completed', completed);
            }

            return { turn: {} };
        };

        const { session, thinkingChanges } = createSessionStub({ closeQueue: false });
        const launcherPromise = codexRemoteLauncher(session as never);

        await waitFor(() => harness.disconnectHandler !== null && session.thinking);
        harness.disconnectHandler?.(new Error('app-server disconnected in test'));

        session.queue.push('message after app-server reconnect', createMode());
        session.queue.close();

        await waitFor(() => harness.startTurnCalls.length === 2);
        const exitReason = await launcherPromise;

        expect(exitReason).toBe('exit');
        expect(harness.startThreadCalls).toHaveLength(1);
        expect(harness.resumeThreadCalls).toHaveLength(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });
});

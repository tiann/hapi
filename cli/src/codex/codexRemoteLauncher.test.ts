import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = vi.hoisted(() => ({
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    requestHandlers: new Map<string, (params: unknown) => Promise<unknown> | unknown>(),
    startTurnHook: null as null | (() => Promise<void>)
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

        registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
            harness.registerRequestCalls.push(method);
            harness.requestHandlers.set(method, handler);
        }

        async startThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(): Promise<{ turn: Record<string, never> }> {
            if (harness.startTurnHook) {
                await harness.startTurnHook();
            }
            const started = { turn: {} };
            harness.notifications.push({ method: 'turn/started', params: started });
            this.notificationHandler?.('turn/started', started);

            const completed = { status: 'Completed', turn: {} };
            harness.notifications.push({ method: 'turn/completed', params: completed });
            this.notificationHandler?.('turn/completed', completed);

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

function createSessionStub() {
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

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.requestHandlers.clear();
        harness.startTurnHook = null;
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

    it('bridges MCP elicitation requests through the remote launcher RPC channel', async () => {
        const {
            session,
            codexMessages,
            rpcHandlers
        } = createSessionStub();
        let elicitationResult: Promise<unknown> | null = null;

        harness.startTurnHook = async () => {
            const elicitationHandler = harness.requestHandlers.get('mcpServer/elicitation/request');
            expect(elicitationHandler).toBeTypeOf('function');

            elicitationResult = Promise.resolve(elicitationHandler?.({
                threadId: 'thread-anonymous',
                turnId: 'turn-1',
                serverName: 'demo-server',
                request: {
                    mode: 'form',
                    message: 'Need MCP input',
                    requestedSchema: {
                        type: 'object',
                        properties: {
                            token: { type: 'string' }
                        }
                    }
                }
            }));

            await Promise.resolve();

            const requestMessage = codexMessages.find((message: any) => message?.name === 'CodexMcpElicitation') as any;
            expect(requestMessage).toBeTruthy();
            expect(requestMessage.input).toMatchObject({
                threadId: 'thread-anonymous',
                turnId: 'turn-1',
                serverName: 'demo-server',
                mode: 'form',
                message: 'Need MCP input'
            });

            const rpcHandler = rpcHandlers.get('mcp-elicitation-response');
            expect(rpcHandler).toBeTypeOf('function');

            await rpcHandler?.({
                id: requestMessage.callId,
                action: 'accept',
                content: {
                    token: 'abc'
                }
            });

            await expect(elicitationResult).resolves.toEqual({
                action: 'accept',
                content: {
                    token: 'abc'
                }
            });
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(rpcHandlers.has('mcp-elicitation-response')).toBe(true);
        expect(harness.registerRequestCalls).toContain('mcpServer/elicitation/request');

        const requestMessage = codexMessages.find((message: any) => message?.name === 'CodexMcpElicitation') as any;
        const resultMessage = codexMessages.find((message: any) => (
            message?.type === 'tool-call-result' && message?.callId === requestMessage?.callId
        )) as any;

        expect(requestMessage).toBeTruthy();
        expect(resultMessage).toMatchObject({
            type: 'tool-call-result',
            callId: requestMessage.callId,
            output: {
                action: 'accept',
                content: {
                    token: 'abc'
                }
            },
            is_error: false
        });
    });

    it('bridges nested MCP URL elicitation requests and preserves URL metadata', async () => {
        const {
            session,
            codexMessages,
            rpcHandlers
        } = createSessionStub();

        harness.startTurnHook = async () => {
            const elicitationHandler = harness.requestHandlers.get('mcpServer/elicitation/request');
            expect(elicitationHandler).toBeTypeOf('function');

            const elicitationResult = Promise.resolve(elicitationHandler?.({
                threadId: 'thread-anonymous',
                turnId: 'turn-2',
                serverName: 'github-auth',
                request: {
                    mode: 'url',
                    message: 'Sign in to continue',
                    url: 'https://example.com/auth',
                    elicitationId: 'elicitation-123'
                }
            }));

            await Promise.resolve();

            const requestMessage = codexMessages.find((message: any) => message?.name === 'CodexMcpElicitation') as any;
            expect(requestMessage).toBeTruthy();
            expect(requestMessage.input).toMatchObject({
                threadId: 'thread-anonymous',
                turnId: 'turn-2',
                serverName: 'github-auth',
                mode: 'url',
                message: 'Sign in to continue',
                url: 'https://example.com/auth',
                elicitationId: 'elicitation-123'
            });

            const rpcHandler = rpcHandlers.get('mcp-elicitation-response');
            expect(rpcHandler).toBeTypeOf('function');

            await rpcHandler?.({
                id: requestMessage.callId,
                action: 'accept',
                content: null
            });

            await expect(elicitationResult).resolves.toEqual({
                action: 'accept',
                content: null
            });
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(harness.registerRequestCalls).toContain('mcpServer/elicitation/request');
    });

    it('rejects malformed nested MCP elicitation payloads before bridging to the UI', async () => {
        const {
            session,
            codexMessages
        } = createSessionStub();

        harness.startTurnHook = async () => {
            const elicitationHandler = harness.requestHandlers.get('mcpServer/elicitation/request');
            expect(elicitationHandler).toBeTypeOf('function');

            await expect(Promise.resolve(elicitationHandler?.({
                threadId: 'thread-anonymous',
                turnId: 'turn-3',
                serverName: 'broken-server',
                request: {
                    message: 'Missing mode'
                }
            }))).rejects.toThrow('Invalid MCP elicitation request: missing mode');

            expect(codexMessages.find((message: any) => message?.name === 'CodexMcpElicitation')).toBeUndefined();
        };

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
    });
});

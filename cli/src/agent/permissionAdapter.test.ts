import { describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, PermissionRequest, PermissionResponse } from './types';
import { PermissionAdapter } from './permissionAdapter';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

type Harness = ReturnType<typeof createHarness>;

function createHarness() {
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    let permissionHandler: ((request: PermissionRequest) => void) | null = null;
    const respondCalls: Array<{
        sessionId: string;
        request: PermissionRequest;
        response: PermissionResponse;
    }> = [];

    const session = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        }
    } as unknown as ApiSessionClient;

    const backend: AgentBackend = {
        async initialize() {},
        async newSession() {
            return 'agent-session';
        },
        async prompt() {},
        async cancelPrompt() {},
        async respondToPermission(sessionId, request, response) {
            respondCalls.push({ sessionId, request, response });
        },
        onPermissionRequest(handler) {
            permissionHandler = handler;
        },
        async disconnect() {}
    };

    new PermissionAdapter(session, backend);

    return {
        rpcHandlers,
        respondCalls,
        getAgentState: () => agentState,
        emitPermissionRequest(request: PermissionRequest) {
            if (!permissionHandler) {
                throw new Error('Permission handler was not registered');
            }
            permissionHandler(request);
        }
    };
}

function createHarnessWithMode(getPermissionMode: () => 'default' | 'read-only' | 'safe-yolo' | 'yolo') {
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    let permissionHandler: ((request: PermissionRequest) => void) | null = null;
    const respondCalls: Array<{
        sessionId: string;
        request: PermissionRequest;
        response: PermissionResponse;
    }> = [];

    const session = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        }
    } as unknown as ApiSessionClient;

    const backend: AgentBackend = {
        async initialize() {},
        async newSession() {
            return 'agent-session';
        },
        async prompt() {},
        async cancelPrompt() {},
        async respondToPermission(sessionId, request, response) {
            respondCalls.push({ sessionId, request, response });
        },
        onPermissionRequest(handler) {
            permissionHandler = handler;
        },
        async disconnect() {}
    };

    new PermissionAdapter(session, backend, getPermissionMode);

    return {
        rpcHandlers,
        respondCalls,
        getAgentState: () => agentState,
        emitPermissionRequest(request: PermissionRequest) {
            if (!permissionHandler) {
                throw new Error('Permission handler was not registered');
            }
            permissionHandler(request);
        }
    };
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function buildRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
    return {
        id: 'perm-1',
        sessionId: 'session-1',
        toolCallId: 'perm-1',
        title: 'Read',
        rawInput: { path: 'README.md' },
        options: [
            {
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once'
            },
            {
                optionId: 'allow-always',
                name: 'Allow always',
                kind: 'allow_always'
            }
        ],
        ...overrides
    };
}

describe('PermissionAdapter', () => {
    it('auto-approves change_title permissions without queueing them', async () => {
        const harness = createHarness();

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-title',
            toolCallId: 'perm-title',
            title: 'hapi_change_title',
            rawInput: { title: 'Rename chat' }
        }));

        await flushAsyncWork();

        expect(harness.respondCalls).toEqual([
            {
                sessionId: 'session-1',
                request: expect.objectContaining({
                    id: 'perm-title',
                    title: 'hapi_change_title'
                }),
                response: { outcome: 'selected', optionId: 'allow-once' }
            }
        ]);
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'perm-title': {
                tool: 'hapi_change_title',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('auto-approves change_title aliases detected from the tool call id', async () => {
        const harness = createHarness();

        harness.emitPermissionRequest(buildRequest({
            id: 'mcp__hapi__change_title-1',
            toolCallId: 'mcp__hapi__change_title-1',
            title: undefined,
            rawInput: { title: 'Rename chat' }
        }));

        await flushAsyncWork();

        expect(harness.respondCalls).toHaveLength(1);
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'mcp__hapi__change_title-1': {
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('keeps non-title permissions pending until the hub responds', async () => {
        const harness = createHarness();

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-read',
            toolCallId: 'perm-read',
            title: 'Read'
        }));

        expect(harness.respondCalls).toEqual([]);
        expect(harness.getAgentState().requests).toMatchObject({
            'perm-read': {
                tool: 'Read'
            }
        });

        const permissionRpc = harness.rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'perm-read',
            approved: true,
            decision: 'approved'
        });

        expect(harness.respondCalls).toEqual([
            {
                sessionId: 'session-1',
                request: expect.objectContaining({
                    id: 'perm-read',
                    title: 'Read'
                }),
                response: { outcome: 'selected', optionId: 'allow-once' }
            }
        ]);
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'perm-read': {
                tool: 'Read',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('auto-approves non-title tools once in safe-yolo mode', async () => {
        const harness = createHarnessWithMode(() => 'safe-yolo');

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-safe',
            toolCallId: 'perm-safe',
            title: 'Read'
        }));

        await flushAsyncWork();

        expect(harness.respondCalls).toEqual([
            {
                sessionId: 'session-1',
                request: expect.objectContaining({
                    id: 'perm-safe',
                    title: 'Read'
                }),
                response: { outcome: 'selected', optionId: 'allow-once' }
            }
        ]);
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'perm-safe': {
                tool: 'Read',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('auto-approves non-title tools for the session in yolo mode', async () => {
        const harness = createHarnessWithMode(() => 'yolo');

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-yolo',
            toolCallId: 'perm-yolo',
            title: 'Read'
        }));

        await flushAsyncWork();

        expect(harness.respondCalls).toEqual([
            {
                sessionId: 'session-1',
                request: expect.objectContaining({
                    id: 'perm-yolo',
                    title: 'Read'
                }),
                response: { outcome: 'selected', optionId: 'allow-always' }
            }
        ]);
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'perm-yolo': {
                tool: 'Read',
                status: 'approved',
                decision: 'approved_for_session'
            }
        });
    });

    it('auto-approves read-only non-write tools but keeps writes pending', async () => {
        const harness = createHarnessWithMode(() => 'read-only');

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-read-only-read',
            toolCallId: 'perm-read-only-read',
            title: 'Read'
        }));

        await flushAsyncWork();

        expect(harness.respondCalls).toEqual([
            {
                sessionId: 'session-1',
                request: expect.objectContaining({
                    id: 'perm-read-only-read',
                    title: 'Read'
                }),
                response: { outcome: 'selected', optionId: 'allow-once' }
            }
        ]);
        expect(harness.getAgentState().completedRequests).toMatchObject({
            'perm-read-only-read': {
                tool: 'Read',
                status: 'approved',
                decision: 'approved'
            }
        });

        harness.emitPermissionRequest(buildRequest({
            id: 'perm-read-only-write',
            toolCallId: 'perm-read-only-write',
            title: 'Patch'
        }));

        expect(harness.respondCalls).toHaveLength(1);
        expect(harness.getAgentState().requests).toMatchObject({
            'perm-read-only-write': {
                tool: 'Patch'
            }
        });
    });
});

import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types';
import { OpencodePermissionHandler } from './permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createHarness(getPermissionMode: () => 'default' | 'yolo' = () => 'default') {
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

    new OpencodePermissionHandler(session, backend, getPermissionMode);

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

function buildRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
    return {
        id: 'perm-1',
        sessionId: 'session-1',
        toolCallId: 'perm-1',
        title: 'Write',
        rawInput: { path: 'file.ts' },
        options: [
            {
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once'
            },
            {
                optionId: 'reject-once',
                name: 'Reject once',
                kind: 'reject_once'
            }
        ],
        ...overrides
    };
}

describe('OpencodePermissionHandler', () => {
    it('queues default-mode tool requests for user approval', () => {
        const harness = createHarness();

        harness.emitPermissionRequest(buildRequest());

        expect(harness.respondCalls).toEqual([]);
        expect(harness.getAgentState().requests).toHaveProperty('perm-1');
    });
});

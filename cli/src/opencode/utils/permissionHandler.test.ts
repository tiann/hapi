import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, PermissionRequest, PermissionResponse } from '@/agent/types';
import { OpencodePermissionHandler, mapDecisionToOutcome } from './permissionHandler';

type FakeAgentState = {
    requests: Record<string, any>;
    completedRequests: Record<string, any>;
};

function createHandler(mode: 'default' | 'yolo' = 'default') {
    let state: FakeAgentState = { requests: {}, completedRequests: {} };
    let permissionRequestHandler: ((request: PermissionRequest) => void) | null = null;
    const rpcHandlers = new Map<string, (value: any) => Promise<void>>();
    const responses: PermissionResponse[] = [];

    const client = {
        rpcHandlerManager: {
            registerHandler(name: string, handler: (value: any) => Promise<void>) {
                rpcHandlers.set(name, handler);
            }
        },
        updateAgentState(updater: (current: FakeAgentState) => FakeAgentState) {
            state = updater(state);
        }
    } as unknown as ApiSessionClient;

    const backend = {
        onPermissionRequest(handler: (request: PermissionRequest) => void) {
            permissionRequestHandler = handler;
        },
        async respondToPermission(_sessionId: string, _request: PermissionRequest, response: PermissionResponse) {
            responses.push(response);
        },
        async cancelPrompt() {}
    } as unknown as AgentBackend;

    new OpencodePermissionHandler(client, backend, () => mode);

    return {
        emit(request: PermissionRequest) {
            if (!permissionRequestHandler) throw new Error('permission handler missing');
            permissionRequestHandler(request);
        },
        respond(value: any) {
            const handler = rpcHandlers.get('permission');
            if (!handler) throw new Error('permission RPC missing');
            return handler(value);
        },
        state: () => state,
        responses
    };
}

function requestWithOptions(options: PermissionRequest['options']): PermissionRequest {
    return {
        id: 'permission-1',
        sessionId: 'session-1',
        toolCallId: 'tool-1',
        title: 'Patch',
        options
    };
}

describe('Opencode permission outcomes', () => {
    it('fails closed when deny has no reject option', () => {
        const request = requestWithOptions([{
            optionId: 'allow-once',
            name: 'Allow once',
            kind: 'allow_once'
        }]);

        expect(mapDecisionToOutcome(request, 'denied')).toEqual({ outcome: 'cancelled' });
    });

    it('fails closed when approve has no allow option', () => {
        const request = requestWithOptions([{
            optionId: 'reject-once',
            name: 'Reject once',
            kind: 'reject_once'
        }]);

        expect(mapDecisionToOutcome(request, 'approved')).toEqual({ outcome: 'cancelled' });
    });

    it.each([
        {
            label: 'deny without reject',
            approved: false,
            decision: 'denied' as const,
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
        },
        {
            label: 'approve without allow',
            approved: true,
            decision: 'approved' as const,
            options: [{ optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' as const }]
        }
    ])('records a native cancellation for $label', async ({ approved, decision, options }) => {
        const harness = createHandler();
        harness.emit(requestWithOptions(options));

        await harness.respond({ id: 'permission-1', approved, decision });

        expect(harness.responses).toEqual([{ outcome: 'cancelled' }]);
        expect(harness.state().requests).toEqual({});
        expect(harness.state().completedRequests['permission-1']).toMatchObject({
            status: 'canceled',
            decision
        });
    });

    it('records auto-approval as canceled when the provider has no allow option', async () => {
        const harness = createHandler('yolo');
        harness.emit(requestWithOptions([{
            optionId: 'reject-once',
            name: 'Reject once',
            kind: 'reject_once'
        }]));

        await vi.waitFor(() => expect(harness.responses).toEqual([{ outcome: 'cancelled' }]));
        expect(harness.state().requests).toEqual({});
        expect(harness.state().completedRequests['permission-1']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        });
    });
});

import { describe, expect, it, vi } from 'vitest';
import { GrokPermissionHandler } from './grokPermissionHandler';
import { GrokCancelTimeoutError } from './grokBackend';

function client() {
    let permission: ((value: any) => Promise<void>) | null = null;
    let state: any = { controlledByUser: false, requests: {}, completedRequests: {} };
    return {
        client: {
            rpcHandlerManager: { registerHandler: (_name: string, handler: any) => { permission = handler; } },
            updateAgentState: (fn: any) => { state = fn(state); }
        },
        respond: (value: any) => permission!(value),
        state: () => state
    };
}

describe('GrokPermissionHandler', () => {
    it.each([
        {
            label: 'deny without a reject option',
            response: { approved: false, decision: 'denied' as const },
            options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
        },
        {
            label: 'approve without an allow option',
            response: { approved: true, decision: 'approved' as const },
            options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
        }
    ])('fails closed for $label', async ({ response, options }) => {
        const c = client();
        const backend: any = {
            onPermissionRequest: vi.fn(),
            onAskUserQuestion: vi.fn(),
            onPlanApproval: vi.fn(),
            respondToPermission: vi.fn(async () => {})
        };
        new GrokPermissionHandler(c.client as any, backend, () => 'default');
        const handlePermission = backend.onPermissionRequest.mock.calls[0][0];
        handlePermission({
            id: 'permission-missing-kind',
            sessionId: 'native-session',
            toolCallId: 'tool-missing-kind',
            title: 'Run command',
            kind: 'execute',
            rawInput: { command: 'echo test' },
            options
        });

        await c.respond({ id: 'permission-missing-kind', ...response });

        expect(backend.respondToPermission).toHaveBeenCalledWith(
            'native-session',
            expect.objectContaining({ id: 'permission-missing-kind' }),
            { outcome: 'cancelled' }
        );
        expect(c.state().requests).toEqual({});
        expect(c.state().completedRequests['permission-missing-kind']).toMatchObject({
            status: 'canceled',
            decision: response.decision
        });
    });

    it('records auto-approval as canceled when the provider has no allow option', async () => {
        const c = client();
        const backend: any = {
            onPermissionRequest: vi.fn(),
            onAskUserQuestion: vi.fn(),
            onPlanApproval: vi.fn(),
            respondToPermission: vi.fn(async () => {})
        };
        new GrokPermissionHandler(c.client as any, backend, () => 'yolo');
        const handlePermission = backend.onPermissionRequest.mock.calls[0][0];
        handlePermission({
            id: 'auto-missing-allow',
            sessionId: 'native-session',
            toolCallId: 'tool-auto-missing-allow',
            title: 'Run command',
            kind: 'execute',
            rawInput: { command: 'echo test' },
            options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
        });

        await vi.waitFor(() => expect(backend.respondToPermission).toHaveBeenCalledWith(
            'native-session',
            expect.objectContaining({ id: 'auto-missing-allow' }),
            { outcome: 'cancelled' }
        ));
        expect(c.state().completedRequests['auto-missing-allow']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        });
    });

    it('maps indexed web answers back to Grok question text', async () => {
        const c = client();
        const backend: any = { onPermissionRequest: vi.fn(), onAskUserQuestion: vi.fn(), onPlanApproval: vi.fn() };
        new GrokPermissionHandler(c.client as any, backend, () => 'default');
        const handler = backend.onAskUserQuestion.mock.calls[0][0];
        const pending = handler({
            sessionId: 's', toolCallId: 'q1',
            questions: [{ question: 'Choose?', options: [{ label: 'Alpha' }], multiSelect: false }]
        });
        await c.respond({ id: 'q1', approved: true, answers: { '0': ['Alpha'] } });
        await expect(pending).resolves.toEqual({ outcome: 'accepted', answers: { 'Choose?': ['Alpha'] } });
    });

    it('maps plan approval and requested changes to native outcomes', async () => {
        const c = client();
        const backend: any = { onPermissionRequest: vi.fn(), onAskUserQuestion: vi.fn(), onPlanApproval: vi.fn() };
        new GrokPermissionHandler(c.client as any, backend, () => 'default');
        const handler = backend.onPlanApproval.mock.calls[0][0];
        const approved = handler({ sessionId: 's', toolCallId: 'p1', planContent: '# Plan' });
        await c.respond({ id: 'p1', approved: true, decision: 'approved' });
        await expect(approved).resolves.toEqual({ outcome: 'approved' });

        const changes = handler({ sessionId: 's', toolCallId: 'p2', planContent: '# Plan' });
        await c.respond({ id: 'p2', approved: false, decision: 'denied', reason: 'Change step 2' });
        await expect(changes).resolves.toEqual({ outcome: 'request_changes', feedback: 'Change step 2' });
    });

    it('finalizes an abort permission after cancellation force-closes the transport', async () => {
        const c = client();
        const backend: any = {
            onPermissionRequest: vi.fn(),
            onAskUserQuestion: vi.fn(),
            onPlanApproval: vi.fn(),
            cancelPrompt: vi.fn(async () => { throw new GrokCancelTimeoutError(10); }),
            respondToPermission: vi.fn(async () => {})
        };
        new GrokPermissionHandler(c.client as any, backend, () => 'default');
        const handlePermission = backend.onPermissionRequest.mock.calls[0][0];
        handlePermission({
            id: 'permission-1',
            sessionId: 'native-session',
            toolCallId: 'tool-1',
            title: 'Run command',
            kind: 'execute',
            rawInput: { command: 'echo test' },
            options: [{ optionId: 'reject', kind: 'reject_once', name: 'Reject' }]
        });

        await expect(c.respond({
            id: 'permission-1',
            approved: false,
            decision: 'abort'
        })).resolves.toBeUndefined();

        expect(backend.respondToPermission).toHaveBeenCalledWith(
            'native-session',
            expect.objectContaining({ id: 'permission-1' }),
            { outcome: 'cancelled' }
        );
        expect(c.state().requests).toEqual({});
        expect(c.state().completedRequests['permission-1']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        });
    });
});

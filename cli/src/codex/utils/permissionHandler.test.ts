import { describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { CodexPermissionHandler } from './permissionHandler';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createHarness(mode: 'default' | 'read-only' | 'safe-yolo' | 'yolo') {
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
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

    const handler = new CodexPermissionHandler(session, () => mode);

    return {
        handler,
        rpcHandlers,
        getAgentState: () => agentState
    };
}

describe('CodexPermissionHandler', () => {
    it('auto-approves change_title tools in default mode', async () => {
        const { handler, getAgentState } = createHarness('default');

        await expect(handler.handleToolCall('perm-1', 'mcp__hapi__change_title', { title: 'Rename' })).resolves.toEqual({
            decision: 'approved'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'mcp__hapi__change_title',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('auto-approves yolo requests for the session', async () => {
        const { handler, getAgentState } = createHarness('yolo');

        await expect(handler.handleToolCall('perm-1', 'CodexPatch', { grantRoot: '/tmp' })).resolves.toEqual({
            decision: 'approved_for_session'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch',
                status: 'approved',
                decision: 'approved_for_session'
            }
        });
    });

    it('auto-approves safe-yolo requests once', async () => {
        const { handler, getAgentState } = createHarness('safe-yolo');

        await expect(handler.handleToolCall('perm-1', 'CodexBash', { command: 'pwd' })).resolves.toEqual({
            decision: 'approved'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexBash',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('keeps default mode requests pending until a permission RPC arrives', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');
        const resultPromise = handler.handleToolCall('perm-1', 'CodexPatch', { grantRoot: '/tmp' });

        expect(getAgentState().requests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch'
            }
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({ id: 'perm-1', approved: true, decision: 'approved' });

        await expect(resultPromise).resolves.toEqual({
            decision: 'approved',
            reason: undefined
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('auto-approves read-only non-write tools but not patches', async () => {
        const { handler, getAgentState } = createHarness('read-only');

        await expect(handler.handleToolCall('read-1', 'Read', { file: 'README.md' })).resolves.toEqual({
            decision: 'approved'
        });

        const patchPromise = handler.handleToolCall('patch-1', 'CodexPatch', { grantRoot: '/tmp' });
        expect(getAgentState().requests).toMatchObject({
            'patch-1': {
                tool: 'CodexPatch'
            }
        });

        handler.reset();
        await expect(patchPromise).rejects.toThrow('Session reset');
    });

    it('keeps request_user_input pending until answers arrive and stores nested answers', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');
        const resultPromise = handler.handleUserInputRequest('input-1', {
            questions: [{ id: 'approve_nav', question: 'Approve app tool call?' }]
        });

        expect(getAgentState().requests).toMatchObject({
            'input-1': {
                tool: 'request_user_input'
            }
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        const answers = {
            approve_nav: {
                answers: ['Allow']
            }
        };

        await permissionRpc?.({
            id: 'input-1',
            approved: true,
            answers
        });

        await expect(resultPromise).resolves.toEqual(answers);

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'input-1': {
                tool: 'request_user_input',
                status: 'approved',
                answers
            }
        });
    });
});

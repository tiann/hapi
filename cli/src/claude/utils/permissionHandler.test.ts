import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '../sdk/prompts';
import type { Session } from '../session';
import type { AgentState } from '@/api/types';

function createFakeSession() {
    const queueItems: { message: string; mode: unknown }[] = [];
    let permissionMode: string | undefined;
    let agentState: AgentState = { requests: {}, completedRequests: {} } as AgentState;
    let rpcHandler: ((response: { id: string }) => Promise<void>) | undefined;

    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn((_method: string, handler: any) => {
                    rpcHandler = handler;
                }),
            },
            updateAgentState: vi.fn((fn: (s: AgentState) => AgentState) => {
                agentState = fn(agentState);
            }),
        },
        queue: {
            unshift: vi.fn((message: string, mode: unknown) => {
                queueItems.push({ message, mode });
            }),
        },
        setPermissionMode: vi.fn((mode: string) => {
            permissionMode = mode;
        }),
        getPermissionMode: vi.fn(() => permissionMode),
    } as unknown as Session;

    return {
        session,
        queueItems,
        getAgentState: () => agentState,
        deliverRpcResponse: (r: { id: string }) => rpcHandler!(r),
    };
}

describe('PermissionHandler — YOLO plan mode', () => {
    it('injects PLAN_FAKE_RESTART and denies exit_plan_mode in bypassPermissions', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        // Simulate Claude emitting an assistant message with exit_plan_mode tool_use
        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-1', name: 'exit_plan_mode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'exit_plan_mode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        // Should deny with PLAN_FAKE_REJECT (so Claude restarts)
        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });

        // Should inject PLAN_FAKE_RESTART into the queue
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
        expect(queueItems[0].mode).toEqual({ permissionMode: 'bypassPermissions' });
    });

    it('injects PLAN_FAKE_RESTART for ExitPlanMode variant', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-2', name: 'ExitPlanMode', input: {} }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'ExitPlanMode',
            {},
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('deny');
        expect(result).toEqual({ behavior: 'deny', message: PLAN_FAKE_REJECT });
        expect(queueItems).toHaveLength(1);
        expect(queueItems[0].message).toBe(PLAN_FAKE_RESTART);
    });

    it('allows normal tools in bypassPermissions without queue injection', async () => {
        const { session, queueItems } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-3', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
        expect(queueItems).toHaveLength(0);
    });

    // Regression: turn-in-progress switch from default to bypassPermissions via
    // SetSessionConfig RPC updates session.setPermissionMode but doesn't go
    // through handler.handleModeChange. The next canCallTool must reflect the
    // new mode. See issue #735.
    it('reflects session permission mode changes between tool calls', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);
        handler.handleModeChange('default');

        // Simulate RPC handler in runClaude updating the session directly,
        // bypassing handler.handleModeChange (as happens on web dropdown change).
        session.setPermissionMode('bypassPermissions');

        handler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tc-4', name: 'Bash', input: { command: 'ls' } }],
            },
        } as any);

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'ls' },
            { permissionMode: 'bypassPermissions' } as any,
            { signal: new AbortController().signal }
        );

        expect(result.behavior).toBe('allow');
    });
});

// tiann/hapi#1735: canceling a pending AskUserQuestion (e.g. Claude sending a
// control_cancel_request) must finalize the request in agentState, and a
// late answer for an untracked request must surface an error rather than
// being silently dropped.
describe('PermissionHandler — canceled request finalization', () => {
    it('finalizes an aborted request as canceled in agentState, and rejects a late answer instead of dropping it', async () => {
        const { session, getAgentState, deliverRpcResponse } = createFakeSession();
        const handler = new PermissionHandler(session);

        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-1', name: 'AskUserQuestion', input: { questions: [] } }] },
        } as any);

        const controller = new AbortController();
        const resultPromise = handler.handleToolCall(
            'AskUserQuestion',
            { questions: [] },
            { permissionMode: 'default' } as any,
            { signal: controller.signal }
        );

        expect(Object.keys(getAgentState().requests ?? {})).toEqual(['tc-1']);

        // Claude Code sends control_cancel_request for this tool call
        controller.abort();
        await expect(resultPromise).rejects.toThrow('Permission request aborted');

        // Fixed: the cancellation is now reflected in agentState, matching
        // the session-level cancelPendingRequests path.
        expect(getAgentState().requests?.['tc-1']).toBeUndefined();
        expect(getAgentState().completedRequests?.['tc-1']).toMatchObject({ status: 'canceled' });

        // Operator answers the now-stale widget anyway; the RPC handler must
        // reject rather than silently succeed.
        await expect(deliverRpcResponse({ id: 'tc-1' } as any)).rejects.toThrow(
            'Permission request not found or already resolved'
        );
    });

    // tiann/hapi#2414: CLI pending map can lose a request without finalize
    // (process death mid-wait, dropped update-state while closing). A late
    // answer must still clear agentState.requests so StatusBar drops
    // "permission required" instead of sticking after the 409.
    it('clears a hub-orphaned request from agentState when a late answer arrives', async () => {
        const { session, getAgentState, deliverRpcResponse } = createFakeSession();
        new PermissionHandler(session);

        session.client.updateAgentState((state) => ({
            ...state,
            requests: {
                ...state.requests,
                'tc-orphan': {
                    tool: 'AskUserQuestion',
                    arguments: { questions: [] },
                    createdAt: 1
                }
            }
        }));
        expect(getAgentState().requests?.['tc-orphan']).toBeDefined();

        await expect(deliverRpcResponse({ id: 'tc-orphan' } as any)).rejects.toThrow(
            'Permission request not found or already resolved'
        );
        expect(getAgentState().requests?.['tc-orphan']).toBeUndefined();
        expect(getAgentState().completedRequests?.['tc-orphan']).toMatchObject({
            status: 'canceled',
            decision: 'abort'
        });
    });

});

describe('PermissionHandler — steer while a request is pending', () => {
    it('denies the pending question so the turn reaches a tool boundary, without aborting the turn', async () => {
        const { session, getAgentState } = createFakeSession();
        const handler = new PermissionHandler(session);

        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-1', name: 'AskUserQuestion', input: { questions: [] } }] },
        } as any);
        const resultPromise = handler.handleToolCall(
            'AskUserQuestion',
            { questions: [] },
            { permissionMode: 'default' } as any,
            { signal: new AbortController().signal }
        );

        handler.denyPendingForSteer();

        await expect(resultPromise).resolves.toMatchObject({ behavior: 'deny' });
        expect(getAgentState().requests?.['tc-1']).toBeUndefined();
        expect(getAgentState().completedRequests?.['tc-1']).toMatchObject({ status: 'denied' });
        expect(handler.isAborted('tc-1')).toBe(false);
    });

    it('keeps the turn running when the pending request is a plan exit', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        handler.onMessage({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc-plan', name: 'ExitPlanMode', input: {} }] },
        } as any);
        const resultPromise = handler.handleToolCall(
            'ExitPlanMode',
            {},
            { permissionMode: 'plan' } as any,
            { signal: new AbortController().signal }
        );

        handler.denyPendingForSteer();

        await expect(resultPromise).resolves.toMatchObject({ behavior: 'deny' });
        expect(handler.isAborted('tc-plan')).toBe(false);
    });
});

describe('PermissionHandler — tool call tracking', () => {
    const toolUse = (id: string, name: string, input: unknown) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    } as any);
    const toolResult = (id: string) => ({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    } as any);
    const trackedIds = (handler: PermissionHandler) =>
        (handler as unknown as { toolCalls: { id: string }[] }).toolCalls.map((call) => call.id);
    const requestPermission = (handler: PermissionHandler, name: string, input: unknown) =>
        handler.handleToolCall(name, input, { permissionMode: 'default' } as any, { signal: new AbortController().signal });

    it('stops tracking a tool call once its result arrives', () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        for (let i = 0; i < 50; i++) {
            handler.onMessage(toolUse(`tc-${i}`, 'Write', { file_path: `/tmp/${i}.txt`, content: 'x'.repeat(1000) }));
            handler.onMessage(toolResult(`tc-${i}`));
        }

        expect(trackedIds(handler)).toEqual([]);
    });

    it('still aborts the turn on an ExitPlanMode result', () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        handler.onMessage(toolUse('tc-plan', 'ExitPlanMode', {}));
        handler.onMessage(toolResult('tc-plan'));

        expect(handler.isAborted('tc-plan')).toBe(true);
        expect(handler.isAborted('tc-other')).toBe(false);
    });

    it('resolves a repeated call to the new tool call, not the finished one', async () => {
        const { session, getAgentState } = createFakeSession();
        const handler = new PermissionHandler(session);

        handler.onMessage(toolUse('tc-1', 'Bash', { command: 'ls' }));
        handler.onMessage(toolResult('tc-1'));
        handler.onMessage(toolUse('tc-2', 'Bash', { command: 'ls' }));
        void requestPermission(handler, 'Bash', { command: 'ls' });
        await Promise.resolve();

        expect(Object.keys(getAgentState().requests ?? {})).toEqual(['tc-2']);
    });

    it('does not resolve a request to a call that already finished', async () => {
        vi.useFakeTimers();
        try {
            const { session, getAgentState } = createFakeSession();
            const handler = new PermissionHandler(session);

            // tc-stale never got a result; the identical tc-done did.
            handler.onMessage(toolUse('tc-stale', 'Bash', { command: 'ls' }));
            handler.onMessage(toolUse('tc-done', 'Bash', { command: 'ls' }));
            handler.onMessage(toolResult('tc-done'));

            const result = requestPermission(handler, 'Bash', { command: 'ls' });
            const rejection = expect(result).rejects.toThrow('Could not resolve tool call ID for Bash');
            await vi.advanceTimersByTimeAsync(1000);
            await rejection;

            expect(getAgentState().requests).toEqual({});
            expect(trackedIds(handler)).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('caps tracking when results never arrive', () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        for (let i = 0; i < 1005; i++) {
            handler.onMessage(toolUse(`tc-${i}`, 'Read', { file_path: `/tmp/${i}.txt` }));
        }

        const ids = trackedIds(handler);
        expect(ids).toHaveLength(1000);
        expect(ids[0]).toBe('tc-5');
        expect(ids[999]).toBe('tc-1004');
    });
});

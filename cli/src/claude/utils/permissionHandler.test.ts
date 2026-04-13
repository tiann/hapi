import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import { PLAN_FAKE_REJECT, PLAN_FAKE_RESTART } from '../sdk/prompts';
import type { Session } from '../session';

function createFakeSession() {
    const queueItems: { message: string; mode: unknown }[] = [];

    const session = {
        client: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn(),
        },
        queue: {
            unshift: vi.fn((message: string, mode: unknown) => {
                queueItems.push({ message, mode });
            }),
        },
        setPermissionMode: vi.fn(),
    } as unknown as Session;

    return { session, queueItems };
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
});

type FakeAgentState = {
    requests?: Record<string, unknown>;
    completedRequests?: Record<string, unknown>;
};

function createSessionStub() {
    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const session = {
        queue: {
            unshiftIsolate: vi.fn()
        },
        clearSessionId: vi.fn(),
        getModeSnapshot: vi.fn(() => ({
            permissionMode: 'plan',
            model: 'sonnet',
            effort: 'high',
            appendSystemPrompt: 'current append prompt'
        })),
        setPermissionMode: vi.fn(),
        client: {
            rpcHandlerManager: {
                registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                    rpcHandlers.set(method, handler);
                }
            },
            updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
                agentState = handler(agentState);
            }
        }
    };

    return {
        session,
        rpcHandlers,
        getAgentState: () => agentState
    };
}

describe('PermissionHandler exit_plan_mode', () => {
    it('defaults to keep_context and preserves the full mode snapshot when restarting', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-exit-plan',
                    name: 'exit_plan_mode',
                    input: { plan: 'Implement the approved plan' }
                }]
            }
        } as never);

        const toolCall = permissionHandler.handleToolCall(
            'exit_plan_mode',
            { plan: 'Implement the approved plan' },
            { permissionMode: 'plan' } as never,
            { signal: new AbortController().signal }
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'tool-exit-plan',
            approved: true
        });

        await expect(toolCall).resolves.toEqual({
            behavior: 'deny',
            message: PLAN_FAKE_REJECT
        });

        expect(session.clearSessionId).not.toHaveBeenCalled();
        expect(session.queue.unshiftIsolate).toHaveBeenCalledWith(PLAN_FAKE_RESTART, {
            permissionMode: 'default',
            model: 'sonnet',
            effort: 'high',
            appendSystemPrompt: 'current append prompt'
        });
        expect(permissionHandler.getResponses().get('tool-exit-plan')).toMatchObject({
            approved: true,
            mode: 'default',
            implementationMode: 'keep_context'
        });

        expect(getAgentState().completedRequests).toMatchObject({
            'tool-exit-plan': {
                status: 'approved',
                implementationMode: 'keep_context'
            }
        });
    });

    it('clears context only when explicitly requested and requeues the approved plan for fresh-context restart', async () => {
        const { session, rpcHandlers } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-exit-plan-accept',
                    name: 'ExitPlanMode',
                    input: { plan: 'Implement with accept-edits' }
                }]
            }
        } as never);

        const toolCall = permissionHandler.handleToolCall(
            'ExitPlanMode',
            { plan: 'Implement with accept-edits' },
            { permissionMode: 'plan' } as never,
            { signal: new AbortController().signal }
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'tool-exit-plan-accept',
            approved: true,
            mode: 'acceptEdits',
            implementationMode: 'clear_context'
        });

        await expect(toolCall).resolves.toEqual({
            behavior: 'deny',
            message: PLAN_FAKE_REJECT
        });

        expect(session.clearSessionId).toHaveBeenCalledTimes(1);
        expect(session.queue.unshiftIsolate).toHaveBeenCalledWith(expect.stringContaining('Implement with accept-edits'), {
            permissionMode: 'acceptEdits',
            model: 'sonnet',
            effort: 'high',
            appendSystemPrompt: 'current append prompt'
        });
    });

    it('clears session-scoped tool allowlists on clear_context so stale approvals do not carry over', async () => {
        const { session, rpcHandlers } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        // Step 1: Approve a Write tool "for session" so it's added to allowedTools
        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-write-1',
                    name: 'Write',
                    input: { file_path: 'foo.ts', content: 'hi' }
                }]
            }
        } as never);

        const writeCall = permissionHandler.handleToolCall(
            'Write',
            { file_path: 'foo.ts', content: 'hi' },
            { permissionMode: 'default' } as never,
            { signal: new AbortController().signal }
        );

        const rpc1 = rpcHandlers.get('permission')!;
        await rpc1({
            id: 'tool-write-1',
            approved: true,
            decision: 'approved_for_session',
            allowTools: ['Write']
        });
        await writeCall;

        // Step 2: Same tool is now auto-allowed (no permission needed)
        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-write-2',
                    name: 'Write',
                    input: { file_path: 'bar.ts', content: 'hi' }
                }]
            }
        } as never);

        const autoResult = await permissionHandler.handleToolCall(
            'Write',
            { file_path: 'bar.ts', content: 'hi' },
            { permissionMode: 'default' } as never,
            { signal: new AbortController().signal }
        );
        expect(autoResult.behavior).toBe('allow');

        // Step 3: Trigger clear_context exit plan
        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-exit-clear',
                    name: 'exit_plan_mode',
                    input: { plan: 'Fresh start' }
                }]
            }
        } as never);

        const exitCall = permissionHandler.handleToolCall(
            'exit_plan_mode',
            { plan: 'Fresh start' },
            { permissionMode: 'plan' } as never,
            { signal: new AbortController().signal }
        );

        const rpc2 = rpcHandlers.get('permission')!;
        await rpc2({
            id: 'tool-exit-clear',
            approved: true,
            mode: 'default',
            implementationMode: 'clear_context'
        });
        await exitCall;

        // Step 4: Write should now require permission again (no longer auto-allowed)
        const abortController = new AbortController();
        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-write-3',
                    name: 'Write',
                    input: { file_path: 'baz.ts', content: 'hi' }
                }]
            }
        } as never);

        const postClearCall = permissionHandler.handleToolCall(
            'Write',
            { file_path: 'baz.ts', content: 'hi' },
            { permissionMode: 'default' } as never,
            { signal: abortController.signal }
        );

        abortController.abort();
        await expect(postClearCall).rejects.toThrow('Permission request aborted');
    });

    it('normalizes invalid post-plan modes to default before updating session state', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-exit-plan-invalid-mode',
                    name: 'exit_plan_mode',
                    input: { plan: 'Implement safely' }
                }]
            }
        } as never);

        const toolCall = permissionHandler.handleToolCall(
            'exit_plan_mode',
            { plan: 'Implement safely' },
            { permissionMode: 'plan' } as never,
            { signal: new AbortController().signal }
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'tool-exit-plan-invalid-mode',
            approved: true,
            mode: 'plan'
        });

        await expect(toolCall).resolves.toEqual({
            behavior: 'deny',
            message: PLAN_FAKE_REJECT
        });

        expect(session.setPermissionMode).toHaveBeenLastCalledWith('default');
        expect(session.queue.unshiftIsolate).toHaveBeenCalledWith(PLAN_FAKE_RESTART, {
            permissionMode: 'default',
            model: 'sonnet',
            effort: 'high',
            appendSystemPrompt: 'current append prompt'
        });
        expect(permissionHandler.getResponses().get('tool-exit-plan-invalid-mode')).toMatchObject({
            approved: true,
            mode: 'default',
            implementationMode: 'keep_context'
        });
        expect(getAgentState().completedRequests).toMatchObject({
            'tool-exit-plan-invalid-mode': {
                status: 'approved',
                mode: 'default',
                implementationMode: 'keep_context'
            }
        });
    });
});

describe('PermissionHandler metadata normalization', () => {
    it('does not apply allowTools or mode side effects when question answers are missing', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-question-empty',
                    name: 'ask_user_question',
                    input: {
                        questions: [{ question: 'Proceed?' }]
                    }
                }]
            }
        } as never);

        const questionCall = permissionHandler.handleToolCall(
            'ask_user_question',
            { questions: [{ question: 'Proceed?' }] },
            { permissionMode: 'default' } as never,
            { signal: new AbortController().signal }
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'tool-question-empty',
            approved: true,
            mode: 'acceptEdits',
            allowTools: ['Edit'],
            answers: {}
        });

        await expect(questionCall).resolves.toEqual({
            behavior: 'deny',
            message: 'No answers were provided.'
        });

        expect(session.setPermissionMode).not.toHaveBeenCalled();
        expect(permissionHandler.getResponses().get('tool-question-empty')).toMatchObject({
            approved: false,
            reason: 'No answers were provided.'
        });
        expect(permissionHandler.getResponses().get('tool-question-empty')?.mode).toBeUndefined();
        expect(permissionHandler.getResponses().get('tool-question-empty')?.allowTools).toBeUndefined();
        expect(getAgentState().completedRequests).toMatchObject({
            'tool-question-empty': {
                status: 'denied',
                reason: 'No answers were provided.'
            }
        });

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-edit-after-empty-answer',
                    name: 'Edit',
                    input: {
                        file_path: 'src/example.ts',
                        old_string: 'before',
                        new_string: 'after'
                    }
                }]
            }
        } as never);

        const abortController = new AbortController();
        const editCall = permissionHandler.handleToolCall(
            'Edit',
            {
                file_path: 'src/example.ts',
                old_string: 'before',
                new_string: 'after'
            },
            { permissionMode: 'default' } as never,
            { signal: abortController.signal }
        );

        expect(getAgentState().requests).toMatchObject({
            'tool-edit-after-empty-answer': {
                tool: 'Edit'
            }
        });

        abortController.abort();
        await expect(editCall).rejects.toThrow('Permission request aborted');
    });

    it('preserves permission decisions in responses and completed requests', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub();
        const permissionHandler = new PermissionHandler(session as never);

        permissionHandler.onMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-edit-decision',
                    name: 'Edit',
                    input: {
                        file_path: 'src/example.ts',
                        old_string: 'before',
                        new_string: 'after'
                    }
                }]
            }
        } as never);

        const toolCall = permissionHandler.handleToolCall(
            'Edit',
            {
                file_path: 'src/example.ts',
                old_string: 'before',
                new_string: 'after'
            },
            { permissionMode: 'default' } as never,
            { signal: new AbortController().signal }
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'tool-edit-decision',
            approved: true,
            decision: 'approved_for_session'
        });

        await expect(toolCall).resolves.toEqual({
            behavior: 'allow',
            updatedInput: {
                file_path: 'src/example.ts',
                old_string: 'before',
                new_string: 'after'
            }
        });

        expect(permissionHandler.getResponses().get('tool-edit-decision')).toMatchObject({
            approved: true,
            decision: 'approved_for_session'
        });
        expect(getAgentState().completedRequests).toMatchObject({
            'tool-edit-decision': {
                status: 'approved',
                decision: 'approved_for_session'
            }
        });
    });
});

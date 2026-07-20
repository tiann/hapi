import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AgentMessage } from '@/agent/types';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { CursorExtensionAdapter } from './cursorExtensionAdapter';

type ExtensionHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>;

function createHarness(options?: { onCreatePlanAccepted?: () => void }) {
    const handlers = new Map<string, ExtensionHandler>();
    let agentState: AgentState = { requests: {}, completedRequests: {} };
    const messages: AgentMessage[] = [];

    const session = {
        updateAgentState(handler: (state: AgentState) => AgentState) {
            agentState = handler(agentState);
        }
    } as unknown as ApiSessionClient;

    const backend = {
        registerExtensionRequestHandler(method: string, handler: ExtensionHandler) {
            handlers.set(method, handler);
        }
    } as unknown as AcpSdkBackend;

    const adapter = new CursorExtensionAdapter(
        session,
        backend,
        (message) => {
            messages.push(message);
        },
        options?.onCreatePlanAccepted
    );

    return {
        handlers,
        adapter,
        getAgentState: () => agentState,
        getMessages: () => messages
    };
}

describe('CursorExtensionAdapter', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    });

    it('queues cursor/ask_question as CursorAskQuestion pending request', async () => {
        const { handlers, getAgentState } = createHarness();
        const handler = handlers.get('cursor/ask_question');
        expect(handler).toBeTypeOf('function');

        const pending = handler!({
            toolCallId: 'q-1',
            questions: [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
        }, null);

        expect(getAgentState().requests).toMatchObject({
            'q-1': {
                tool: 'CursorAskQuestion',
                createdAt: 1_700_000_000_000
            }
        });

        void pending;
    });

    it('resolves ask_question with answered outcome and formatted answers', async () => {
        const { handlers, adapter } = createHarness();
        const pending = handlers.get('cursor/ask_question')!({
            toolCallId: 'q-1',
            questions: []
        }, null);

        const handled = await adapter.handlePermissionResponse({
            id: 'q-1',
            approved: true,
            answers: { q1: ['opt-a'] }
        });
        expect(handled).toBe(true);
        // Cursor ACP expects the outcome nested under `outcome` (see cursor.com/docs/cli/acp).
        await expect(pending).resolves.toEqual({
            outcome: {
                outcome: 'answered',
                answers: [{ questionId: 'q1', selectedOptionIds: ['opt-a'] }]
            }
        });
    });

    it('resolves ask_question denial as cancelled', async () => {
        const { handlers, adapter } = createHarness();
        const pending = handlers.get('cursor/ask_question')!({ toolCallId: 'q-2' }, null);

        await adapter.handlePermissionResponse({
            id: 'q-2',
            approved: false,
            decision: 'denied'
        });

        await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('resolves create_plan approval as accepted with nested outcome envelope', async () => {
        // Regression for the plan-approval bug: operator clicks "Yes" on a Cursor
        // CreatePlan approval, but the agent received `User cancelled` because the
        // response outcome was returned flat instead of nested. Cursor reads
        // `response.outcome.outcome`, so the envelope MUST be nested.
        const onCreatePlanAccepted = vi.fn();
        const { handlers, adapter } = createHarness({ onCreatePlanAccepted });
        const pending = handlers.get('cursor/create_plan')!({
            toolCallId: 'plan-1',
            plan: '# Plan'
        }, null);

        await adapter.handlePermissionResponse({
            id: 'plan-1',
            approved: true,
            decision: 'approved'
        });

        await expect(pending).resolves.toEqual({ outcome: { outcome: 'accepted' } });
        expect(onCreatePlanAccepted).toHaveBeenCalledOnce();
    });

    it('resolves create_plan approved_for_session as accepted with nested envelope', async () => {
        const onCreatePlanAccepted = vi.fn();
        const { handlers, adapter } = createHarness({ onCreatePlanAccepted });
        const pending = handlers.get('cursor/create_plan')!({
            toolCallId: 'plan-1b',
            plan: '# Plan'
        }, null);

        await adapter.handlePermissionResponse({
            id: 'plan-1b',
            approved: true,
            decision: 'approved_for_session'
        });

        await expect(pending).resolves.toEqual({ outcome: { outcome: 'accepted' } });
        expect(onCreatePlanAccepted).toHaveBeenCalledOnce();
    });

    it('does not invoke create-plan continue handoff on denial or abort', async () => {
        const onCreatePlanAccepted = vi.fn();
        const { handlers, adapter } = createHarness({ onCreatePlanAccepted });
        const denied = handlers.get('cursor/create_plan')!({ toolCallId: 'plan-deny' }, null);
        const aborted = handlers.get('cursor/create_plan')!({ toolCallId: 'plan-abort' }, null);

        await adapter.handlePermissionResponse({
            id: 'plan-deny',
            approved: false,
            decision: 'denied'
        });
        await adapter.handlePermissionResponse({
            id: 'plan-abort',
            approved: false,
            decision: 'abort'
        });

        await expect(denied).resolves.toEqual({ outcome: { outcome: 'rejected' } });
        await expect(aborted).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(onCreatePlanAccepted).not.toHaveBeenCalled();
    });

    it('does not invoke create-plan continue handoff for ask_question answers', async () => {
        const onCreatePlanAccepted = vi.fn();
        const { handlers, adapter } = createHarness({ onCreatePlanAccepted });
        const pending = handlers.get('cursor/ask_question')!({ toolCallId: 'q-ok' }, null);

        await adapter.handlePermissionResponse({
            id: 'q-ok',
            approved: true,
            answers: { q1: ['a'] }
        });

        await expect(pending).resolves.toMatchObject({
            outcome: { outcome: 'answered' }
        });
        expect(onCreatePlanAccepted).not.toHaveBeenCalled();
    });

    it('resolves create_plan denial as rejected', async () => {
        const { handlers, adapter } = createHarness();
        const pending = handlers.get('cursor/create_plan')!({ toolCallId: 'plan-2' }, null);

        await adapter.handlePermissionResponse({
            id: 'plan-2',
            approved: false,
            decision: 'denied'
        });

        await expect(pending).resolves.toEqual({ outcome: { outcome: 'rejected' } });
    });

    it('resolves create_plan abort as cancelled', async () => {
        const { handlers, adapter } = createHarness();
        const pending = handlers.get('cursor/create_plan')!({ toolCallId: 'plan-3' }, null);

        await adapter.handlePermissionResponse({
            id: 'plan-3',
            approved: false,
            decision: 'abort'
        });

        await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('returns false from handlePermissionResponse for unrelated permission ids', async () => {
        const { adapter } = createHarness();
        const handled = await adapter.handlePermissionResponse({
            id: 'perm-read',
            approved: true
        });
        expect(handled).toBe(false);
    });

    it('maps cursor/update_todos to plan agent messages', async () => {
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/update_todos')!({
            todos: [
                { content: 'Step one', status: 'in_progress' },
                { content: 'Step two', status: 'completed' }
            ]
        }, null);

        expect(getMessages()).toEqual([
            {
                type: 'plan',
                items: [
                    { content: 'Step one', priority: 'medium', status: 'in_progress' },
                    { content: 'Step two', priority: 'medium', status: 'completed' }
                ]
            }
        ]);
    });

    it('emits CursorTask tool call and result for cursor/task', async () => {
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/task')!({
            toolCallId: 'task-1',
            title: 'Run tests'
        }, null);

        expect(getMessages()).toEqual([
            expect.objectContaining({
                type: 'tool_call',
                id: 'task-1',
                name: 'CursorTask',
                status: 'completed'
            }),
            expect.objectContaining({
                type: 'tool_result',
                id: 'task-1',
                status: 'completed'
            })
        ]);
    });

    it('keeps CursorTask running when status is in_progress', async () => {
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/task')!({
            toolCallId: 'task-2',
            title: 'Subagent',
            status: 'in_progress'
        }, null);

        expect(getMessages()).toEqual([
            expect.objectContaining({
                type: 'tool_call',
                id: 'task-2',
                name: 'CursorTask',
                status: 'in_progress'
            })
        ]);
    });

    it('cancelAll resolves pending extension requests as cancelled', async () => {
        const { handlers, adapter, getAgentState } = createHarness();
        const askPending = handlers.get('cursor/ask_question')!({ toolCallId: 'q-cancel' }, null);
        const planPending = handlers.get('cursor/create_plan')!({ toolCallId: 'p-cancel' }, null);

        await adapter.cancelAll('User aborted');

        await expect(askPending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        await expect(planPending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'q-cancel': { status: 'canceled', decision: 'abort' },
            'p-cancel': { status: 'canceled', decision: 'abort' }
        });
    });
});

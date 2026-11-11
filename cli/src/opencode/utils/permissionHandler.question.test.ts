import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend, FormElicitationRequest, FormElicitationResponse } from '@/agent/types';
import type { OpencodePermissionMode } from '@hapi/protocol/types';
import { OpencodePermissionHandler } from './permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn()
    }
}));

type FakeAgentState = {
    requests: Record<string, { tool: string; arguments: unknown }>;
    completedRequests: Record<string, Record<string, unknown>>;
};

const schema = {
    type: 'object',
    properties: {
        q0: {
            type: 'string',
            title: '승인',
            description: '승인 요청 테스트: 동작 확인',
            oneOf: [
                { const: '거절', title: '거절', description: '거절합니다' },
                { const: '승인', title: '승인', description: '승인합니다' }
            ]
        },
        q0_custom: { type: 'string' }
    },
    required: []
};

function elicitation(overrides: Partial<FormElicitationRequest> = {}): FormElicitationRequest {
    return {
        sessionId: 'session-1',
        toolCallId: 'call-question',
        message: 'Questions',
        requestedSchema: schema,
        ...overrides
    };
}

function createHarness(mode: OpencodePermissionMode = 'default') {
    let agentState: FakeAgentState = { requests: {}, completedRequests: {} };
    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    let elicitationHandler: ((request: FormElicitationRequest) => Promise<FormElicitationResponse>) | null = null;
    const cancelPrompt = vi.fn(async () => {});
    const respondToPermission = vi.fn(async () => {});

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
        cancelPrompt,
        respondToPermission,
        onPermissionRequest() {},
        onFormElicitation(handler) {
            elicitationHandler = handler;
        },
        async disconnect() {}
    };

    const handler = new OpencodePermissionHandler(session, backend, () => mode);

    return {
        handler,
        cancelPrompt,
        respondToPermission,
        getAgentState: () => agentState,
        ask(request: FormElicitationRequest = elicitation()) {
            if (!elicitationHandler) throw new Error('Elicitation handler was not registered');
            return elicitationHandler(request);
        },
        respond(response: Record<string, unknown>) {
            const rpc = rpcHandlers.get('permission');
            if (!rpc) throw new Error('permission rpc handler missing');
            return rpc(response);
        }
    };
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
        done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return done;
}

describe('OpencodePermissionHandler question forms', () => {
    it('queues the form as an AskUserQuestion request keyed by the tool call id', async () => {
        const harness = createHarness();

        const pending = harness.ask();

        expect(harness.getAgentState().requests).toEqual({
            'call-question': {
                tool: 'AskUserQuestion',
                arguments: {
                    questions: [{
                        header: '승인',
                        question: '승인 요청 테스트: 동작 확인',
                        options: [
                            { label: '거절', description: '거절합니다' },
                            { label: '승인', description: '승인합니다' }
                        ],
                        multiSelect: false,
                        allowFreeText: true
                    }]
                },
                createdAt: expect.any(Number)
            }
        });
        expect(await settled(pending)).toBe(false);
    });

    it('returns the chosen label to OpenCode and records the answer', async () => {
        const harness = createHarness();
        const pending = harness.ask();

        await harness.respond({ id: 'call-question', approved: true, answers: { '0': ['승인'] } });

        await expect(pending).resolves.toEqual({ action: 'accept', content: { q0: '승인' } });
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests['call-question']).toMatchObject({
            tool: 'AskUserQuestion',
            status: 'approved',
            answers: { '0': ['승인'] }
        });
    });

    it('accepts the nested answers format', async () => {
        const harness = createHarness();
        const pending = harness.ask();

        await harness.respond({ id: 'call-question', approved: true, answers: { '0': { answers: ['거절'] } } });

        await expect(pending).resolves.toEqual({ action: 'accept', content: { q0: '거절' } });
    });

    it.each(['yolo', 'safe-yolo', 'always-proceed', 'read-only', 'plan', 'default'] as const)(
        'never answers the question on its own in %s mode',
        async (mode) => {
            const harness = createHarness(mode as OpencodePermissionMode);

            const pending = harness.ask();

            expect(await settled(pending)).toBe(false);
            expect(harness.getAgentState().requests['call-question']).toBeDefined();
            expect(harness.getAgentState().completedRequests).toEqual({});
            expect(harness.respondToPermission).not.toHaveBeenCalled();
        }
    );

    it('dismisses the form when the user denies it', async () => {
        const harness = createHarness();
        const pending = harness.ask();

        await harness.respond({ id: 'call-question', approved: false, decision: 'denied' });

        await expect(pending).resolves.toEqual({ action: 'cancel' });
        expect(harness.getAgentState().completedRequests['call-question']).toMatchObject({ status: 'denied' });
    });

    it('dismisses the form when approval carries no answers', async () => {
        const harness = createHarness();
        const pending = harness.ask();

        await harness.respond({ id: 'call-question', approved: true, answers: {} });

        await expect(pending).resolves.toEqual({ action: 'cancel' });
        expect(harness.getAgentState().completedRequests['call-question']).toMatchObject({
            status: 'denied',
            reason: 'No answers were provided.'
        });
    });

    it('dismisses the form on an abort decision', async () => {
        const harness = createHarness();
        const pending = harness.ask();

        await harness.respond({ id: 'call-question', approved: false, decision: 'abort' });

        await expect(pending).resolves.toEqual({ action: 'cancel' });
    });

    it('cancels every pending form when the session aborts, ends or the turn finishes', async () => {
        const harness = createHarness();
        const first = harness.ask();
        const second = harness.ask(elicitation({ toolCallId: 'call-2' }));

        await harness.handler.cancelAll('User aborted');

        await expect(first).resolves.toEqual({ action: 'cancel' });
        await expect(second).resolves.toEqual({ action: 'cancel' });
        expect(harness.getAgentState().requests).toEqual({});
        expect(harness.getAgentState().completedRequests['call-question']).toMatchObject({
            status: 'canceled',
            reason: 'User aborted'
        });
    });

    it('ignores a late web answer after the form was cancelled', async () => {
        const harness = createHarness();
        const pending = harness.ask();
        await harness.handler.cancelAll('Prompt finished');

        await harness.respond({ id: 'call-question', approved: true, answers: { '0': ['승인'] } });

        await expect(pending).resolves.toEqual({ action: 'cancel' });
        expect(harness.getAgentState().completedRequests['call-question']).toMatchObject({ status: 'canceled' });
    });

    it('dismisses forms it cannot represent without showing a card', async () => {
        const harness = createHarness();

        await expect(harness.ask(elicitation({
            requestedSchema: { type: 'object', properties: { q0: { type: 'number' } } }
        }))).resolves.toEqual({ action: 'cancel' });

        expect(harness.getAgentState().requests).toEqual({});
    });

    it('cancels an earlier form that reuses the same tool call id', async () => {
        const harness = createHarness();
        const first = harness.ask();
        const second = harness.ask();

        await expect(first).resolves.toEqual({ action: 'cancel' });
        await harness.respond({ id: 'call-question', approved: true, answers: { '0': ['승인'] } });
        await expect(second).resolves.toEqual({ action: 'accept', content: { q0: '승인' } });
    });

    it('generates an id when the agent links no tool call', async () => {
        const harness = createHarness();

        void harness.ask(elicitation({ toolCallId: undefined }));

        const ids = Object.keys(harness.getAgentState().requests);
        expect(ids).toHaveLength(1);
        expect(ids[0]).toMatch(/^opencode-question-/);
    });

    it('cancels a form that arrives after Stop without queuing a card', async () => {
        const harness = createHarness();

        await harness.handler.cancelAll('User aborted');
        const late = harness.ask();

        await expect(late).resolves.toEqual({ action: 'cancel' });
        expect(harness.getAgentState().requests).toEqual({});
    });

    it('shows questions again once a new turn begins', async () => {
        const harness = createHarness();
        await harness.handler.cancelAll('User aborted');
        harness.handler.beginTurn();

        const pending = harness.ask();

        expect(await settled(pending)).toBe(false);
        expect(harness.getAgentState().requests['call-question']).toBeDefined();
    });
});

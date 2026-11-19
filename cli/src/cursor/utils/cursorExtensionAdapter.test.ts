import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AgentMessage } from '@/agent/types';
import { AcpSdkBackend } from '@/agent/backends/acp';
import { clearGeneratedImages, getGeneratedImage } from '@/modules/common/generatedImages';
import { CursorExtensionAdapter } from './cursorExtensionAdapter';

type ExtensionHandler = (params: unknown, requestId: string | number | null) => Promise<unknown>;

function createHarness(options?: { onCreatePlanAccepted?: () => void }) {
    const handlers = new Map<string, ExtensionHandler>();
    let agentState: AgentState = { requests: {}, completedRequests: {} };
    let update: ((state: AgentState) => AgentState) | undefined;
    const messages: AgentMessage[] = [];

    const session = {
        updateAgentState(handler: (state: AgentState) => AgentState) {
            update = handler;
            agentState = handler(agentState);
        }
    } as unknown as ApiSessionClient;

    const backend = {
        registerExtensionRequestHandler(method: string, handler: ExtensionHandler) {
            handlers.set(method, handler);
        },
        // Lifetime mapping is covered against the real backend below.
        resolveToolCallLifetimeId: (agentToolCallId: string) => agentToolCallId,
        allocateToolCallRequestId: (lifetimeId: string) => lifetimeId
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
        reapply: (state: AgentState) => update!(state),
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
                toolCallId: 'q-1',
                createdAt: 1_700_000_000_000
            }
        });

        void pending;
    });

    it('preserves a pending Cursor question when an ACK retry sees newer state', async () => {
        const f = createHarness();
        const pending = f.handlers.get('cursor/ask_question')!({ toolCallId: 'q-1', questions: [] }, null);
        const newer = { ...f.getAgentState(), steeringActive: true };
        vi.mocked(Date.now).mockReturnValue(1_700_000_001_000);
        expect(f.reapply(newer)).toBe(newer);
        expect(f.reapply({}).requests?.['q-1']?.createdAt).toBe(1_700_000_000_000);
        await f.adapter.cancelAll('test cleanup');
        await pending;
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

    it('registers cursor/generate_image base64 imageData and emits generated_image', async () => {
        clearGeneratedImages();
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/generate_image')!({
            toolCallId: 'img-1',
            description: 'App icon',
            filePath: '/tmp/icon.png',
            imageData: pngHeader.toString('base64'),
        }, null);

        const messages = getMessages();
        expect(messages[0]).toMatchObject({
            type: 'tool_call',
            id: 'img-1',
            name: 'CursorGenerateImage',
            status: 'completed',
        });
        expect(messages[1]).toMatchObject({
            type: 'generated_image',
            fileName: 'icon.png',
            mimeType: 'image/png',
            source: {
                ingress: 'acp',
                flavor: 'cursor',
                toolCallId: 'img-1',
                toolName: 'cursor/generate_image',
            },
        });
        expect(messages[2]).toMatchObject({
            type: 'tool_result',
            id: 'img-1',
            status: 'completed',
        });

        const generated = messages[1];
        expect(generated.type).toBe('generated_image');
        if (generated.type === 'generated_image') {
            expect(getGeneratedImage(generated.imageId)?.mimeType).toBe('image/png');
        }
        clearGeneratedImages();
    });

    it('does not read filePath-only generate_image (permission bypass)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-cursor-gen-img-'));
        try {
            const filePath = join(dir, 'secret.png');
            writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

            const { handlers, getMessages } = createHarness();
            await handlers.get('cursor/generate_image')!({
                toolCallId: 'img-path',
                description: 'Must not auto-read disk',
                filePath,
            }, null);

            expect(getMessages().map((m) => m.type)).toEqual(['tool_call', 'tool_result']);
            expect(getMessages().some((m) => m.type === 'generated_image')).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            clearGeneratedImages();
        }
    });

    it('registers cursor/generate_image base64 imageData when filePath is absent', async () => {
        clearGeneratedImages();
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/generate_image')!({
            toolCallId: 'img-2',
            description: 'Inline bytes',
            imageData: pngHeader.toString('base64'),
        }, null);

        const generated = getMessages().find((m) => m.type === 'generated_image');
        expect(generated).toMatchObject({
            type: 'generated_image',
            mimeType: 'image/png',
            source: {
                ingress: 'acp',
                flavor: 'cursor',
                toolCallId: 'img-2',
                toolName: 'cursor/generate_image',
            },
        });
        clearGeneratedImages();
    });

    it('rejects oversized generate_image base64 before decode', async () => {
        const { handlers, getMessages } = createHarness();
        const huge = 'A'.repeat(Math.ceil(25 * 1024 * 1024 * 4 / 3) + 5);
        await handlers.get('cursor/generate_image')!({
            toolCallId: 'img-huge',
            description: 'Too big',
            imageData: huge,
        }, null);

        expect(getMessages().map((m) => m.type)).toEqual(['tool_call', 'tool_result']);
        expect(getMessages().some((m) => m.type === 'generated_image')).toBe(false);
        const toolCall = getMessages()[0];
        expect(toolCall).toMatchObject({
            type: 'tool_call',
            input: expect.objectContaining({ imageDataChars: huge.length }),
        });
        if (toolCall.type === 'tool_call') {
            expect(toolCall.input).not.toHaveProperty('imageData');
        }
    });

    it('still emits tool_call/result when generate_image has no path or bytes', async () => {
        const { handlers, getMessages } = createHarness();
        await handlers.get('cursor/generate_image')!({
            toolCallId: 'img-3',
            description: 'No media yet',
        }, null);

        expect(getMessages().map((m) => m.type)).toEqual(['tool_call', 'tool_result']);
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

describe('CursorExtensionAdapter with the ACP backend', () => {
    // The suite above pins Date.now; the backend's quiet windows need a real clock.
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('keys extension requests and task cards by the lifetime id of the ACP tool call', async () => {
        const backend = new AcpSdkBackend({ command: 'cursor-agent', flavor: 'cursor' });
        const handlers = new Map<string, ExtensionHandler>();
        let agentState: AgentState = { requests: {}, completedRequests: {} };
        const extensionMessages: AgentMessage[] = [];
        // Capture the handlers instead of wiring them to a transport.
        backend.registerExtensionRequestHandler = (method, handler) => {
            handlers.set(method, handler as ExtensionHandler);
        };
        new CursorExtensionAdapter(
            { updateAgentState: (update: (state: AgentState) => AgentState) => { agentState = update(agentState); } } as unknown as ApiSessionClient,
            backend,
            (message) => extensionMessages.push(message)
        );
        const internal = backend as unknown as {
            handleNotification: (method: string, params: unknown) => void;
            transport: unknown;
        };
        internal.transport = {
            sendRequest: async () => {
                internal.handleNotification('session/update', {
                    sessionId: 'session-1',
                    update: { sessionUpdate: 'tool_call', toolCallId: 'call-ask', title: 'Ask question', kind: 'other', status: 'pending', rawInput: { q: 1 } }
                });
                void handlers.get('cursor/ask_question')!({ toolCallId: 'call-ask', questions: [] }, null);
                return { stopReason: 'end_turn' };
            },
            sendNotification: () => {},
            close: async () => {}
        };
        const promptMessages: AgentMessage[] = [];
        await backend.prompt('session-1', [{ type: 'text', text: 'ask me' }], (message) => promptMessages.push(message));

        const callId = promptMessages.find((message) => message.type === 'tool_call')?.id;
        expect(callId).toMatch(/^call-ask#/);
        expect(Object.keys(agentState.requests ?? {})).toEqual([callId]);
        expect(agentState.requests?.[callId!]).toMatchObject({ toolCallId: callId });

        await handlers.get('cursor/task')!({ toolCallId: 'task-a', status: 'running' }, null);
        await handlers.get('cursor/task')!({ toolCallId: 'task-a', status: 'completed' }, null);
        const taskIds = extensionMessages.flatMap((message) => (message.type === 'tool_call' || message.type === 'tool_result' ? [message.id] : []));
        expect(new Set(taskIds).size).toBe(1);
        expect(taskIds[0]).toMatch(/^task-a#/);
    }, 20_000);
});

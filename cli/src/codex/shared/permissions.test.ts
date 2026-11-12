import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexPermissions } from './permissions';

function fixture() {
    let state: AgentState = {};
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const markAttachmentDenied = vi.fn();
    const markAttachmentApproved = vi.fn();
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        markAttachmentDenied,
        markAttachmentApproved,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) } } as unknown as ApiSessionClient;
    const respond = vi.fn();
    const permissions = new SharedCodexPermissions(session, { respond } as unknown as CodexAppServerClient, 'generation');
    const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
        questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }] } };
    return { permissions, request, respond, handlers, send, markAttachmentDenied, markAttachmentApproved, state: () => state };
}
describe('shared request arbitration', () => {
    it.each([{ notes: [] }, { notes: ['user_note: custom answer'] }])('preserves isOther and canonical other answers (%j) without claiming a winner', async ({ notes }) => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, isBlocking: true,
            questions: f.request.params.questions.map(question => ({ ...question, isOther: true })) } };
        f.permissions.receive(request);
        const [id, pending] = Object.entries(f.state().requests ?? {})[0]!;
        expect(pending.arguments).toEqual(request.params);
        const answers = { choice: { answers: ['None of the above', ...notes] } };
        await f.handlers.get('permission')!({ id, approved: true, answers });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers }));
        expect(f.state().completedRequests).toBeUndefined();
        f.permissions.resolved('thread', request.id);
        expect(f.state().completedRequests?.[id]).toMatchObject({ status: 'resolved' });
        expect(f.state().completedRequests?.[id]).not.toHaveProperty('answers');
    });

    it('withdrawal on disconnect is canceled, not a claim that a native answer won', () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.close();
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('canceled');
        expect(f.respond).not.toHaveBeenCalled();
        expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'tool-call-result', callId: 'call', output: { status: 'canceled' }, is_error: false
        }), 'codex:thread:question:call:canceled');
    });
    it('native resolution in the same tick cannot resurrect a prompt or submit a late answer', async () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.resolved('thread', 1);
        await Promise.resolve(); await Promise.resolve();
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('resolved');
        expect(f.respond).not.toHaveBeenCalled();
        f.permissions.receive(f.request); expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(f.send.mock.calls).toEqual([
            [{ type: 'tool-call', name: 'request_user_input', callId: 'call', input: f.request.params,
                id: 'codex:thread:question:call:start' }, 'codex:thread:question:call:start'],
            [{ type: 'tool-call-result', callId: 'call', output: { status: 'resolved' }, is_error: false,
                id: 'codex:thread:question:call:resolved' }, 'codex:thread:question:call:resolved']
        ]);
    });
    it('validates all answers before submitting; sending is not proof of winning', async () => {
        const f = fixture(); f.permissions.receive(f.request);
        const id = Object.keys(f.state().requests ?? {})[0]; const reply = f.handlers.get('permission')!;
        await expect(reply({ id, approved: true, answers: {} })).rejects.toThrow('Missing answer');
        await reply({ id, approved: true, answers: { choice: ['B'] } });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers: { choice: { answers: ['B'] } } }));
        expect(f.state().completedRequests).toBeUndefined();
        expect(f.send).toHaveBeenCalledTimes(1); // Submission alone is not a result.
        f.permissions.resolved('thread', 1);
        expect(Object.values(f.state().completedRequests ?? {})[0]).toMatchObject({ status: 'resolved' });
        expect(Object.values(f.state().completedRequests ?? {})[0]).not.toHaveProperty('answers');
    });
    it('keeps child questions in their agent trace and replay IDs stable across reconnects', () => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, threadId: 'child' } };
        f.permissions.receive(request); f.permissions.resolved('child', request.id);
        expect(f.send.mock.calls[0][0]).toMatchObject({ type: 'agent-run-trace', agentId: 'child',
            message: { type: 'tool-call', name: 'request_user_input', callId: 'call' },
            scope: { role: 'child', parentThreadId: 'thread' } });
        const again = fixture(); again.permissions.receive(request); again.permissions.resolved('child', request.id);
        expect(again.send.mock.calls).toEqual(f.send.mock.calls);
    });
    it('ignores unsupported requests, including requests for an unknown MCP elicitation form', async () => {
        const f = fixture();
        f.permissions.receive({ id: 2, method: 'future/request', params: { threadId: 'thread' } });
        await Promise.resolve(); expect(f.respond).not.toHaveBeenCalled();
    });

    it('times the wait for the user from receive to the answer reaching Codex', async () => {
        let waitOpens = 0;
        let waitCloses = 0;
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        const respond = vi.fn();
        const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => { handlers.set(key, fn); } }
        } as unknown as ApiSessionClient;
        const permissions = new SharedCodexPermissions(session, { respond } as unknown as CodexAppServerClient, 'generation',
            undefined, threadId => {
                expect(threadId).toBe('thread');
                waitOpens += 1;
                return () => { waitCloses += 1; };
            });
        const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
            questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }] }] } };
        permissions.receive(request);
        expect(waitOpens).toBe(1);
        expect(waitCloses).toBe(0);
        const id = Object.keys((session.updateAgentState as ReturnType<typeof vi.fn>).mock.calls
            .at(-1)![0]({}).requests ?? {})[0];
        await handlers.get('permission')!({ id, approved: true, answers: { choice: ['A'] } });
        await vi.waitFor(() => expect(respond).toHaveBeenCalled());
        expect(waitCloses).toBe(1);
    });

    it('closes the wait when the request is withdrawn without an answer', async () => {
        let waitCloses = 0;
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: vi.fn(),
            updateAgentState: vi.fn(),
            rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => { handlers.set(key, fn); } }
        } as unknown as ApiSessionClient;
        const permissions = new SharedCodexPermissions(session, { respond: vi.fn() } as unknown as CodexAppServerClient, 'generation',
            undefined, () => () => { waitCloses += 1; });
        const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
            questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }] }] } };
        permissions.receive(request);
        permissions.resolved('thread', request.id);
        await vi.waitFor(() => expect(waitCloses).toBe(1));
    });

    it('marks attachment denied when a tool request for read_file or display_media is denied in SharedCodexPermissions', async () => {
        const f = fixture();
        const request = {
            id: 2,
            method: 'item/tool/requestApproval',
            params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'call-read-1',
                tool: 'read_file',
                input: { path: '/workspace/private.txt' }
            }
        };
        f.permissions.receive(request);
        const [id] = Object.entries(f.state().requests ?? {})[0]!;
        await f.handlers.get('permission')!({ id, approved: false, decision: 'denied' });
        expect(f.markAttachmentDenied).toHaveBeenCalledWith('/workspace/private.txt');
    });

    it('marks attachment denied when a file request is canceled or resolved via native terminal without web approval', () => {
        const f = fixture();
        const request = {
            id: 3,
            method: 'item/tool/requestApproval',
            params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'call-read-terminal',
                tool: 'mcp__filesystem__read_file',
                input: { path: '/workspace/terminal-denied.txt' }
            }
        };
        f.permissions.receive(request);
        // Neutral native resolution without web approval: serverRequest/resolved calls resolved(thread, 3)
        f.permissions.resolved('thread', 3);
        expect(f.markAttachmentDenied).toHaveBeenCalledWith('/workspace/terminal-denied.txt');
    });

    it('marks attachment approved when a file request is web-approved and resolved natively', async () => {
        const f = fixture();
        const request = {
            id: 4,
            method: 'item/tool/requestApproval',
            params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'call-read-approved',
                tool: 'read_file',
                input: { path: '/workspace/web-approved.txt' }
            }
        };
        f.permissions.receive(request);
        const [id] = Object.entries(f.state().requests ?? {})[0]!;
        await f.handlers.get('permission')!({ id, approved: true, decision: 'approved' });
        f.permissions.resolved('thread', 4, 'resolved');
        expect(f.markAttachmentApproved).toHaveBeenCalledWith('/workspace/web-approved.txt');
    });

    it('preserves web denial even when native resolution arrives with status=resolved', async () => {
        const f = fixture();
        const request = {
            id: 5,
            method: 'item/tool/requestApproval',
            params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'call-read-web-denied',
                tool: 'read_file',
                input: { path: '/workspace/web-denied.txt' }
            }
        };
        f.permissions.receive(request);
        const [id] = Object.entries(f.state().requests ?? {})[0]!;
        await f.handlers.get('permission')!({ id, approved: false, decision: 'denied' });
        // Native serverRequest/resolved arrives with status='resolved'
        f.permissions.resolved('thread', 5, 'resolved');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/web-denied.txt');
        expect(f.markAttachmentDenied).toHaveBeenCalledWith('/workspace/web-denied.txt');
    });

    it('marks attachment approved when execution evidence arrives through observeExecution', () => {
        const f = fixture();
        f.permissions.observeExecution('read_file', { path: '/workspace/executed.txt', status: 'completed' });
        expect(f.markAttachmentApproved).toHaveBeenCalledWith('/workspace/executed.txt');

        // Accept null error field on successful completions
        f.permissions.observeExecution('read_file', { path: '/workspace/null-error.txt', status: 'completed', error: null, result: { Ok: 'success' } });
        expect(f.markAttachmentApproved).toHaveBeenCalledWith('/workspace/null-error.txt');
    });

    it('does not mark attachment approved when execution completed with failure or error', () => {
        const f = fixture();
        f.permissions.observeExecution('read_file', { path: '/workspace/failed.txt', status: 'failed' });
        f.permissions.observeExecution('read_file', { path: '/workspace/errored.txt', is_error: true });
        f.permissions.observeExecution('read_file', { path: '/workspace/cancelled.txt', status: 'cancelled' });
        f.permissions.observeExecution('read_file', { path: '/workspace/mcp-err.txt', status: 'completed', result: { Err: 'permission denied' } });
        f.permissions.observeExecution('read_file', { path: '/workspace/mcp-iserror.txt', status: 'completed', result: { isError: true } });
        f.permissions.observeExecution('read_file', { path: '/workspace/mcp-ok-iserror.txt', status: 'completed', result: { Ok: { isError: true } } });
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/failed.txt');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/errored.txt');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/cancelled.txt');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/mcp-err.txt');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/mcp-iserror.txt');
        expect(f.markAttachmentApproved).not.toHaveBeenCalledWith('/workspace/mcp-ok-iserror.txt');
    });
});

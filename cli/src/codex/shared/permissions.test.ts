import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexPermissions } from './permissions';

function fixture() {
    let state: AgentState = {};
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) } } as unknown as ApiSessionClient;
    const respond = vi.fn();
    const permissions = new SharedCodexPermissions(session, { respond } as unknown as CodexAppServerClient, 'generation');
    const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
        questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }] } };
    return { permissions, request, respond, handlers, send, state: () => state };
}
describe('shared request arbitration', () => {
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
});

import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '@hapi/protocol/types';
import { PtyPermissionHandler } from './ptyPermissionHandler';
import type { PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

type PermissionRpcHandler = (response: {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}) => Promise<void> | void;

function createFakeClient() {
    let permissionHandler: PermissionRpcHandler | null = null;
    const state: { requests: Record<string, unknown>; completedRequests: Record<string, unknown> } = {
        requests: {},
        completedRequests: {}
    };

    const client: PermissionHandlerClient = {
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: unknown) => {
                if (method === RPC_METHODS.Permission) {
                    permissionHandler = handler as PermissionRpcHandler;
                }
            })
        },
        updateAgentState: vi.fn((handler: (s: any) => any) => {
            Object.assign(state, handler(state));
        })
    };

    return {
        client,
        state,
        respond: (response: Parameters<PermissionRpcHandler>[0]) => {
            if (!permissionHandler) throw new Error('Permission RPC handler not registered');
            return permissionHandler(response);
        }
    };
}

describe('PtyPermissionHandler', () => {
    it('auto-allows pure read-only tools without a web round trip', async () => {
        const { client, state } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']) {
            const decision = await handler.requestDecision(`id-${tool}`, tool, {});
            expect(decision.permissionDecision).toBe('allow');
        }
        // never surfaced a request to the web
        expect(Object.keys(state.requests)).toHaveLength(0);
    });

    it('routes AskUserQuestion to the web and injects the picked answers via updatedInput', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const input = { questions: [{ question: 'Pick a color?', header: 'Color' }] };
        const pending = handler.requestDecision('q1', 'AskUserQuestion', input);
        // surfaced in agent state so the web shows the question card
        expect(state.requests['q1']).toMatchObject({ tool: 'AskUserQuestion' });

        await respond({ id: 'q1', approved: true, answers: { '0': ['Blue'] } });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('allow');
        // claude's AskUserQuestion expects answers keyed by question text
        expect(decision.updatedInput).toMatchObject({ answers: { 'Pick a color?': 'Blue' } });
    });

    it('under bypassPermissions (--yolo), auto-allows permission tools but still forwards question tools to the web', async () => {
        const { client, state } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'bypassPermissions' });

        // A permission-gated tool is auto-allowed — yolo semantics are preserved.
        const bash = await handler.requestDecision('b1', 'Bash', { command: 'ls' });
        expect(bash.permissionDecision).toBe('allow');
        expect(state.requests['b1']).toBeUndefined();

        // AskUserQuestion must NOT be auto-allowed even under bypassPermissions:
        // it has to surface in the web so the question reaches the chat instead
        // of rendering only in the PTY's interactive selector.
        handler.requestDecision('q-yolo', 'AskUserQuestion', { questions: [{ question: 'Web or CLI?', header: 'Form' }] });
        expect(state.requests['q-yolo']).toMatchObject({ tool: 'AskUserQuestion' });

        // request_user_input is handled the same way.
        handler.requestDecision('r-yolo', 'request_user_input', { prompt: 'Anything else?' });
        expect(state.requests['r-yolo']).toMatchObject({ tool: 'request_user_input' });
    });

    it('mirrors the SDK under acceptEdits: auto-allows edit tools, asks for the rest', async () => {
        const { client, state } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'acceptEdits' });

        // Edit tools are auto-allowed, matching the SDK canCallTool path.
        for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
            const dec = await handler.requestDecision(`e-${tool}`, tool, { file_path: '/x' });
            expect(dec.permissionDecision).toBe('allow');
            expect(state.requests[`e-${tool}`]).toBeUndefined();
        }

        // A non-edit tool still goes to the web modal under acceptEdits.
        handler.requestDecision('b1', 'Bash', { command: 'ls' });
        expect(state.requests['b1']).toMatchObject({ tool: 'Bash' });
    });

    it('denies AskUserQuestion when no answers are provided', async () => {
        const { client, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('q2', 'AskUserQuestion', { questions: [{ question: 'X?' }] });
        await respond({ id: 'q2', approved: true, answers: {} });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('deny');
    });

    it('denies AskUserQuestion when answers cannot be mapped to questions (never stalls)', async () => {
        const { client, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        // Web sends a non-empty answer, but the index doesn't line up with any
        // question text, so the claude-shaped map comes out empty. Allowing here
        // would make claude echo "answered: ." and lock the turn — deny instead.
        const pending = handler.requestDecision('q3', 'AskUserQuestion', { questions: [{ question: 'X?' }] });
        await respond({ id: 'q3', approved: true, answers: { '5': ['Stray'] } });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('deny');
        expect(decision.updatedInput).toBeUndefined();
    });

    it('auto-allows everything in bypassPermissions (the --yolo mapping)', async () => {
        const { client, state } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'bypassPermissions' });

        const decision = await handler.requestDecision('b1', 'Bash', { command: 'rm -rf /tmp/x' });
        expect(decision.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests)).toHaveLength(0);
    });

    it('routes gated tools to the web modal and resolves allow on approval', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('tool-1', 'Bash', { command: 'ls' });
        // surfaced in agent state for the web modal
        expect(state.requests['tool-1']).toMatchObject({ tool: 'Bash' });

        await respond({ id: 'tool-1', approved: true });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('allow');
        expect(decision.updatedInput).toEqual({ command: 'ls' });
    });

    it('resolves deny (never ask) when the user rejects', async () => {
        const { client, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('tool-2', 'Write', { file_path: '/etc/x' });
        await respond({ id: 'tool-2', approved: false, reason: 'nope' });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('deny');
        expect(decision.reason).toContain('nope');
    });

    it('remembers "allow for session" tools and skips re-prompting', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('w-1', 'WebFetch', { url: 'https://a' });
        await respond({ id: 'w-1', approved: true, allowTools: ['WebFetch'] });
        expect((await first).permissionDecision).toBe('allow');

        // second call to the same tool is auto-allowed without a new request
        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('w-2', 'WebFetch', { url: 'https://b' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);
    });

    it('honors "allow for session" for a Bash command (web sends Bash(<cmd>))', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('b-1', 'Bash', { command: 'echo hi' });
        // web's "Allow For Session" for claude Bash sends the command-qualified id
        await respond({ id: 'b-1', approved: true, allowTools: ['Bash(echo hi)'] });
        expect((await first).permissionDecision).toBe('allow');

        // same command auto-allows without a new web request
        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('b-2', 'Bash', { command: 'echo hi' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);
    });

    it('still prompts for a different Bash command after a literal session-allow', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('b-1', 'Bash', { command: 'echo hi' });
        await respond({ id: 'b-1', approved: true, allowTools: ['Bash(echo hi)'] });
        await first;

        // a DIFFERENT command is not covered by the literal allow → surfaces a request
        handler.requestDecision('b-2', 'Bash', { command: 'rm -rf /' });
        expect(state.requests['b-2']).toMatchObject({ tool: 'Bash' });
    });

    it('honors a Bash prefix session-allow (Bash(<prefix>:*))', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('p-1', 'Bash', { command: 'npm test' });
        await respond({ id: 'p-1', approved: true, allowTools: ['Bash(npm:*)'] });
        await first;

        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('p-2', 'Bash', { command: 'npm run build' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);
    });

    it('propagates a mode switch chosen alongside the approval', async () => {
        const { client, respond } = createFakeClient();
        const onModeChange = vi.fn();
        const handler = new PtyPermissionHandler(client, {
            getPermissionMode: () => 'default',
            onModeChange
        });

        const pending = handler.requestDecision('e-1', 'Edit', { file_path: '/x' });
        await respond({ id: 'e-1', approved: true, mode: 'acceptEdits' });
        await pending;
        expect(onModeChange).toHaveBeenCalledWith('acceptEdits');
    });

    it('cancelAll rejects in-flight requests (deny path for teardown)', async () => {
        const { client, respond: _respond } = createFakeClient();
        const handler = new PtyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('c-1', 'Bash', { command: 'sleep 999' });
        handler.cancelAll('Session ended');
        await expect(pending).rejects.toThrow('Session ended');
    });
});

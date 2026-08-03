import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '@hapi/protocol/types';
import { AgyPermissionHandler } from './agyPermissionHandler';
import type { PermissionHandlerClient } from '@/modules/common/permission/BasePermissionHandler';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

type PermissionRpcHandler = (response: {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: PermissionMode;
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    answers?: Record<string, string[]>;
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

describe('AgyPermissionHandler', () => {
    it('auto-allows agy read-only tools without a web round trip', async () => {
        const { client, state } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const readOnlyTools = ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'read_url_content', 'search_web', 'list_permissions'];
        for (const tool of readOnlyTools) {
            const decision = await handler.requestDecision(`id-${tool}`, tool, {});
            expect(decision.permissionDecision).toBe('allow');
        }
        // never surfaced a request to the web
        expect(Object.keys(state.requests)).toHaveLength(0);
    });

    it('routes run_command to the web modal and resolves allow on approval', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('conv-1:3', 'run_command', { CommandLine: 'echo hi', Cwd: '/tmp' });
        expect(state.requests['conv-1:3']).toMatchObject({ tool: 'run_command' });

        await respond({ id: 'conv-1:3', approved: true });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('allow');
    });

    it('resolves deny when the user rejects', async () => {
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('conv-2:1', 'write_to_file', { path: '/etc/x' });
        await respond({ id: 'conv-2:1', approved: false, reason: 'nope' });
        const decision = await pending;
        expect(decision.permissionDecision).toBe('deny');
        expect(decision.reason).toContain('nope');
    });

    it('auto-allows everything in yolo mode (agy\'s only auto-allow mode)', async () => {
        const { client, state } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'yolo' });

        const decision = await handler.requestDecision('b-1', 'run_command', { CommandLine: 'rm -rf /tmp/x' });
        expect(decision.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests)).toHaveLength(0);
    });

    it('remembers "allow for session" tools and skips re-prompting', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('c-1:0', 'write_to_file', { path: '/tmp/x' });
        await respond({ id: 'c-1:0', approved: true, allowTools: ['write_to_file'] });
        expect((await first).permissionDecision).toBe('allow');

        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('c-2:0', 'write_to_file', { path: '/tmp/y' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);
    });

    it('scopes decision-only session approval to the exact pending command', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });
        const first = handler.requestDecision('c-decision:0', 'run_command', { CommandLine: 'npm test' });
        await respond({ id: 'c-decision:0', approved: true, decision: 'approved_for_session' });
        const decision = await first;
        expect(decision.permissionOverrides).toEqual(['command(npm test)']);
        expect((await handler.requestDecision('c-decision:1', 'run_command', { CommandLine: 'npm test' })).permissionDecision).toBe('allow');
        const different = handler.requestDecision('c-decision:2', 'run_command', { CommandLine: 'npm publish' });
        expect(state.requests['c-decision:2']).toMatchObject({ tool: 'run_command' });
        await respond({ id: 'c-decision:2', approved: false });
        expect((await different).permissionDecision).toBe('deny');
        expect(decision.permissionOverrides).not.toContain('command(*)');
    });

    it('includes permissionOverrides in the decision for session-allows', async () => {
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('c-3:0', 'run_command', { CommandLine: 'npm test' });
        await respond({ id: 'c-3:0', approved: true, allowTools: ['command(npm test)'] });
        const decision = await first;
        expect(decision.permissionDecision).toBe('allow');
        expect(decision.permissionOverrides).toContain('command(npm test)');
    });

    it('cancelAll rejects in-flight requests', async () => {
        const { client } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const pending = handler.requestDecision('d-1:0', 'run_command', { CommandLine: 'sleep 999' });
        handler.cancelAll('Session ended');
        await expect(pending).rejects.toThrow('Session ended');
    });

    it('propagates mode change from approval response', async () => {
        const { client, respond } = createFakeClient();
        const onModeChange = vi.fn();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default', onModeChange });

        const pending = handler.requestDecision('e-1:0', 'write_to_file', { path: '/x' });
        await respond({ id: 'e-1:0', approved: true, mode: 'acceptEdits' });
        await pending;
        expect(onModeChange).toHaveBeenCalledWith('acceptEdits');
    });

    // --- #1 security: session-allow scoping ---

    it('bare run_command session-allow emits command(<CommandLine>), NOT command(*)', async () => {
        // Security: approving a single run_command must not grant command(*)
        // (which would allow ALL commands for the rest of the session).
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        // The web sends bare 'run_command' as the session-allow token when the
        // PermissionFooter uses toolName === 'Bash'-style (no specific command).
        const pending = handler.requestDecision('f-1:0', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        await respond({ id: 'f-1:0', approved: true, allowTools: ['run_command'] });
        const decision = await pending;

        expect(decision.permissionDecision).toBe('allow');
        // Must be scoped to the actual CommandLine, never command(*).
        expect(decision.permissionOverrides).toContain('command(echo hello)');
        expect(decision.permissionOverrides).not.toContain('command(*)');
    });

    it('bare run_command session-allow only allows that specific command, not others', async () => {
        // After approving 'echo hello' for the session, a different command must
        // still prompt the user — not be silently allowed.
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        // First approval: echo hello
        const first = handler.requestDecision('f-2:0', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        await respond({ id: 'f-2:0', approved: true, allowTools: ['run_command'] });
        await first;

        // A different command must NOT be auto-allowed.
        const before = Object.keys(state.requests).length;
        const second = handler.requestDecision('f-2:1', 'run_command', { CommandLine: 'rm -rf /tmp/x', Cwd: '/tmp' });
        // The request should be pending in state (not auto-resolved).
        expect(Object.keys(state.requests).length).toBeGreaterThan(before);

        // Clean up.
        handler.cancelAll('test cleanup');
        await expect(second).rejects.toThrow();
    });

    it('command(<cmd>) session-allow from the web is passed through and remembered', async () => {
        // When the web already sends command(<specific>), it should be preserved
        // as-is and allow that command without re-prompting.
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('f-3:0', 'run_command', { CommandLine: 'npm test', Cwd: '/tmp' });
        await respond({ id: 'f-3:0', approved: true, allowTools: ['command(npm test)'] });
        const decision = await first;
        expect(decision.permissionDecision).toBe('allow');
        expect(decision.permissionOverrides).toContain('command(npm test)');

        // Same command: auto-allowed now, no new pending request.
        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('f-3:1', 'run_command', { CommandLine: 'npm test', Cwd: '/tmp' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);

        // Different command: still prompts.
        const third = handler.requestDecision('f-3:2', 'run_command', { CommandLine: 'npm run build', Cwd: '/tmp' });
        expect(Object.keys(state.requests).length).toBeGreaterThan(before);
        handler.cancelAll('test cleanup');
        await expect(third).rejects.toThrow();
    });

    // --- n1: a denied response must never populate the session-allow cache ---

    it('n1: a deny response carrying allowTools does NOT grant a future allow', async () => {
        // Invariant: only an approved response may seed the session-allow cache.
        // The hub only sends allowTools on approval today, but a malformed or
        // denied response carrying allowTools must never escalate into a cached
        // allow on the next invocation.
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('n1:0', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        // Denied, but the response (wrongly) carries allowTools.
        await respond({ id: 'n1:0', approved: false, allowTools: ['run_command', 'command(echo hello)', 'write_to_file'] });
        expect((await first).permissionDecision).toBe('deny');

        // The same command must still prompt — the deny did not cache an allow.
        const before = Object.keys(state.requests).length;
        const second = handler.requestDecision('n1:1', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        expect(Object.keys(state.requests).length).toBeGreaterThan(before);

        // The generic tool must also still prompt.
        const third = handler.requestDecision('n1:2', 'write_to_file', { path: '/tmp/x' });
        expect(Object.keys(state.requests).length).toBeGreaterThan(before + 1);

        handler.cancelAll('test cleanup');
        await expect(second).rejects.toThrow();
        await expect(third).rejects.toThrow();
    });

    // --- M2: bare run_command session-allow caches in allowedCommandLiterals ---

    it('M2: bare run_command session-allow auto-allows the same command on re-invocation (HAPI cache consistent)', async () => {
        // After the web sends bare `run_command` session-allow for a pending
        // `echo hello`, the same command must be auto-allowed next time without
        // re-prompting (previously it was written to sessionAllowedTools which
        // requestDecision never reads for run_command — the inert write bug).
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('m2:0', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        await respond({ id: 'm2:0', approved: true, allowTools: ['run_command'] });
        const firstDecision = await first;
        expect(firstDecision.permissionDecision).toBe('allow');
        // The permission override must be command-scoped (not command(*)).
        expect(firstDecision.permissionOverrides).toContain('command(echo hello)');

        // Same command: must be auto-allowed (no new pending request).
        const before = Object.keys(state.requests).length;
        const second = await handler.requestDecision('m2:1', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        expect(second.permissionDecision).toBe('allow');
        expect(Object.keys(state.requests).length).toBe(before);
    });

    it('M2: bare run_command session-allow does NOT auto-allow a different command', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const first = handler.requestDecision('m2b:0', 'run_command', { CommandLine: 'echo hello', Cwd: '/tmp' });
        await respond({ id: 'm2b:0', approved: true, allowTools: ['run_command'] });
        await first;

        // A different command must still prompt.
        const before = Object.keys(state.requests).length;
        const second = handler.requestDecision('m2b:1', 'run_command', { CommandLine: 'rm -rf /', Cwd: '/tmp' });
        expect(Object.keys(state.requests).length).toBeGreaterThan(before);

        handler.cancelAll('test cleanup');
        await expect(second).rejects.toThrow();
    });

    // --- ask_question (agy's native TUI selector, never PreToolUse-hooked) ---
    // agy never calls requestDecision() for ask_question (no PreToolUse fires
    // for it), so agyPtyLauncher registers it directly via
    // registerQuestionRequest, reusing the SAME pending-request/agentState/
    // `permission` RPC machinery as every other tool so the web's
    // AskUserQuestionView/Footer render it without any new wiring.

    it('registerQuestionRequest surfaces a pending ask_user_question request in agentState', async () => {
        const { client, state } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }, { label: 'Bar' }], multiSelect: false }] };
        const pending = handler.registerQuestionRequest('conv-1:5:ask', canonicalInput);

        expect(state.requests['conv-1:5:ask']).toMatchObject({ tool: 'ask_user_question', arguments: canonicalInput });

        handler.cancelAll('test cleanup');
        await expect(pending).rejects.toThrow();
    });

    it('registerQuestionRequest resolves with the normalized answers on approval', async () => {
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }, { label: 'Bar' }], multiSelect: false }] };
        const pending = handler.registerQuestionRequest('conv-2:1:ask', canonicalInput);

        await respond({ id: 'conv-2:1:ask', approved: true, answers: { '0': ['Bar'] } });
        const answers = await pending;
        expect(answers).toEqual({ '0': ['Bar'] });
    });

    it('registerQuestionRequest resolves with null when no answers were provided', async () => {
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }], multiSelect: false }] };
        const pending = handler.registerQuestionRequest('conv-3:1:ask', canonicalInput);

        await respond({ id: 'conv-3:1:ask', approved: false });
        const answers = await pending;
        expect(answers).toBeNull();
    });

    // --- Finding F1: invalidate pending questions without collateral damage ---
    // A question can outlive the PTY selector that rendered it (crash/respawn,
    // or a turn abort that interrupts the TUI without killing the process). If
    // nothing cancels the stale pending request, a later web answer resolves it
    // and the CLI injects the built key sequence into whatever is now on
    // screen — an idle prompt or a brand-new turn. cancelPendingQuestions must
    // reject ONLY the ask_user_question pending requests, leaving unrelated
    // pending tool-approval requests (which the agy process may still be
    // legitimately blocked on) untouched.

    it('cancelPendingQuestions rejects a pending ask_user_question request', async () => {
        const { client, state } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }], multiSelect: false }] };
        const pending = handler.registerQuestionRequest('conv-5:1:ask', canonicalInput);

        handler.cancelPendingQuestions('PTY exited while a question was pending');
        await expect(pending).rejects.toThrow('PTY exited while a question was pending');
        expect(state.completedRequests['conv-5:1:ask']).toMatchObject({ status: 'canceled' });
        expect(state.requests['conv-5:1:ask']).toBeUndefined();
    });

    it('cancelPendingQuestions does NOT reject a pending run_command/tool-approval request', async () => {
        const { client, state, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }], multiSelect: false }] };
        const questionPending = handler.registerQuestionRequest('conv-6:1:ask', canonicalInput);
        const toolPending = handler.requestDecision('conv-6:2', 'run_command', { CommandLine: 'echo hi' });

        handler.cancelPendingQuestions('turn aborted');

        await expect(questionPending).rejects.toThrow('turn aborted');
        // The unrelated tool-approval request must still be pending (not
        // rejected, still resolvable via a normal approval response).
        expect(state.requests['conv-6:2']).toMatchObject({ tool: 'run_command' });

        // Clean up: it must still resolve normally afterward.
        await respond({ id: 'conv-6:2', approved: true });
        const decision = await toolPending;
        expect(decision.permissionDecision).toBe('allow');
    });

    it('registerQuestionRequest does not pollute the run_command/write_to_file session-allow state', async () => {
        // The question pending-request path must be fully independent of the
        // regular tool-approval bookkeeping (sessionAllowedTools, Bash
        // literal/prefix caches) — it shares only the generic pending-request
        // registry, not any tool-approval side effects.
        const { client, respond } = createFakeClient();
        const handler = new AgyPermissionHandler(client, { getPermissionMode: () => 'default' });

        const canonicalInput = { questions: [{ question: 'Pick one', options: [{ label: 'Foo' }], multiSelect: false }] };
        const pending = handler.registerQuestionRequest('conv-4:1:ask', canonicalInput);
        await respond({ id: 'conv-4:1:ask', approved: true, answers: { '0': ['Foo'] } });
        await pending;

        // A real run_command right after must still prompt normally (no
        // leftover session-allow from the question flow).
        const decision = handler.requestDecision('conv-4:2', 'run_command', { CommandLine: 'echo hi' });
        expect(decision).toBeInstanceOf(Promise);
        handler.cancelAll('test cleanup');
        await expect(decision).rejects.toThrow();
    });
});

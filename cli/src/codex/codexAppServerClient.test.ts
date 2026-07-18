import { describe, expect, it, vi } from 'vitest';
import { buildCodexAppServerArgs, CodexAppServerClient, CodexAppServerError, formatCodexAppServerFailure, getCodexAppServerEnv } from './codexAppServerClient';

describe('buildCodexAppServerArgs', () => {
    it('uses the standard app-server command by default', () => {
        expect(buildCodexAppServerArgs({})).toEqual(['app-server']);
    });

    it('passes HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT as a Codex app-server config override', () => {
        expect(buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '24000'
        })).toEqual([
            'app-server',
            '-c',
            'model_auto_compact_token_limit=24000'
        ]);
    });

    it('accepts whitespace-padded auto-compaction token limits', () => {
        expect(buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: ' 24000'
        })).toEqual([
            'app-server',
            '-c',
            'model_auto_compact_token_limit=24000'
        ]);
        expect(buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '24000 '
        })).toEqual([
            'app-server',
            '-c',
            'model_auto_compact_token_limit=24000'
        ]);
    });

    it('treats blank auto-compaction token limits as unset', () => {
        expect(buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: ''
        })).toEqual(['app-server']);
        expect(buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: ' '
        })).toEqual(['app-server']);
    });

    it('rejects invalid auto-compaction token limits', () => {
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '24_000'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '0'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '-1'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '1.5'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '1e6'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
        expect(() => buildCodexAppServerArgs({
            HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT: '9007199254740992'
        })).toThrow('HAPI_CODEX_AUTO_COMPACT_TOKEN_LIMIT must be a positive integer');
    });
});


describe('CodexAppServerClient', () => {
    it('preserves JSON-RPC method, code, data, and written state without leaking secrets', async () => {
        const client = new CodexAppServerClient() as unknown as {
            connected: boolean;
            process: { stdin: { write: () => boolean } };
            startTurn: CodexAppServerClient['startTurn'];
            handleResponse: (response: unknown) => void;
        };
        client.connected = true;
        client.process = { stdin: { write: () => true } };
        const request = client.startTurn({ threadId: 'thread', input: [], cwd: '/tmp', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } as never);
        client.handleResponse({ id: 1, error: { code: -32001, message: 'Permission denied for private prompt Bearer secret-token sk-abcdefghijk', data: { kind: 'workspace', prompt: 'do not leak me' } } });
        const error = await request.catch((value) => value) as CodexAppServerError;
        expect(error).toMatchObject({ method: 'turn/start', code: -32001, data: { kind: 'workspace' }, writeState: 'written' });
        expect(error.message).not.toContain('secret-token');
        expect(error.message).not.toContain('sk-abcdefghijk');
        expect(error.message).not.toContain('private prompt');
        expect(JSON.stringify(error.data)).not.toContain('do not leak me');
        expect(formatCodexAppServerFailure(error)).toContain('could not access the workspace');
    });

    it('strips cross-provider credentials and managed launch metadata from the app-server child', () => {
        expect(getCodexAppServerEnv({
            PATH: '/usr/bin', OPENAI_API_KEY: 'codex-ok',
            GEMINI_API_KEY: 'no', ANTIGRAVITY_API_KEY: 'no', ANTHROPIC_API_KEY: 'no',
            HAPI_LAUNCH_NONCE: 'no', HAPI_RUNNER_INSTANCE_ID: 'no', HAPI_EXPECTED_NATIVE_RESUME_ID: 'no'
        })).toEqual({ PATH: '/usr/bin', OPENAI_API_KEY: 'codex-ok' });
    });

    it('uses Process exited unexpectedly only for observed child exits', () => {
        const requestFailure = new CodexAppServerError({ method: 'turn/start', message: 'unknown request failure', writeState: 'written' });
        const childExit = new CodexAppServerError({ method: 'turn/start', message: 'child gone', writeState: 'written', childExit: { code: 9, signal: null } });
        expect(formatCodexAppServerFailure(requestFailure)).not.toContain('Process exited unexpectedly');
        expect(formatCodexAppServerFailure(childExit)).toBe('Process exited unexpectedly (code=9, signal=null)');
    });

    it('distinguishes native resume failures, active turn conflicts, and aborts', () => {
        expect(formatCodexAppServerFailure(new CodexAppServerError({ method: 'thread/resume', message: 'not found', writeState: 'written' }))).toContain('Native resume failed');
        expect(formatCodexAppServerFailure(new CodexAppServerError({ method: 'turn/start', message: 'turn already active', writeState: 'written' }))).toContain('active turn');
        const aborted = new CodexAppServerError({ method: 'turn/steer', message: 'Request aborted', writeState: 'written' });
        aborted.name = 'AbortError';
        expect(formatCodexAppServerFailure(aborted)).toBe('Aborted by user');
    });

    it('preserves written state when a request is aborted after transport write', async () => {
        const client = new CodexAppServerClient() as unknown as {
            connected: boolean;
            process: { stdin: { write: () => boolean } };
            sendRequest: (method: string, params: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
        };
        client.connected = true;
        client.process = { stdin: { write: () => true } };
        const controller = new AbortController();

        const request = client.sendRequest('turn/steer', {}, { signal: controller.signal });
        controller.abort();

        await expect(request).rejects.toMatchObject({
            name: 'AbortError',
            method: 'turn/steer',
            writeState: 'written'
        });
    });

    it('reports not-written when the transport throws before accepting the payload', async () => {
        const client = new CodexAppServerClient() as unknown as {
            connected: boolean;
            process: { stdin: { write: () => boolean } };
            sendRequest: (method: string, params: unknown) => Promise<unknown>;
        };
        client.connected = true;
        client.process = { stdin: { write: () => { throw new Error('pipe closed'); } } };

        await expect(client.sendRequest('turn/steer', {})).rejects.toMatchObject({
            method: 'turn/steer',
            writeState: 'not-written'
        });
    });

    it('sends turn/steer with expectedTurnId to live-append into an active turn', async () => {
        const client = new CodexAppServerClient();
        const sendRequest = vi.spyOn(client as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> }, 'sendRequest')
            .mockResolvedValue({ turnId: 'turn-123' });
        const params = {
            threadId: 'thread-123',
            expectedTurnId: 'turn-123',
            input: [{ type: 'text' as const, text: 'use the failing tests first' }]
        };

        const result = await (client as unknown as { steerTurn: (next: typeof params) => Promise<unknown> }).steerTurn(params);

        expect(result).toEqual({ turnId: 'turn-123' });
        expect(sendRequest).toHaveBeenCalledWith('turn/steer', params, {
            signal: undefined,
            timeoutMs: CodexAppServerClient.DEFAULT_TIMEOUT_MS
        });
    });

    it('marks malformed turn/steer responses as post-write ambiguity', async () => {
        const client = new CodexAppServerClient();
        vi.spyOn(client as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> }, 'sendRequest')
            .mockResolvedValue({ unexpected: 'private prompt text' });
        const params = {
            threadId: 'thread-123', expectedTurnId: 'turn-123',
            input: [{ type: 'text' as const, text: 'private prompt text' }]
        };

        await expect(client.steerTurn(params)).rejects.toMatchObject({
            name: 'CodexAppServerError', method: 'turn/steer', writeState: 'written'
        });
    });
});

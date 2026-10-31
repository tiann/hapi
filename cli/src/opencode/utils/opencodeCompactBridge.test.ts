import { describe, expect, it, vi } from 'vitest';
import { captureCompactionMarkerSnapshot, fetchCompactionResult, fetchCompactionResultV2, pollCompactionResultV2, readOpencodeV2ServerPassword, splitProviderModel, triggerOpencodeCompact, triggerOpencodeCompactV2 } from './opencodeCompactBridge';

// `signal` is a required field (see OpencodeCompactCallOpts's doc comment) —
// most tests below don't exercise abort behavior at all, so this is a
// signal that's simply never aborted, just satisfying the type.
const noSignal = new AbortController().signal;

describe('splitProviderModel', () => {
    it('splits a combined "provider/model" wire id on the first slash', () => {
        expect(splitProviderModel('ollama/qwen3.6:35b-a3b-q8_0-mtp')).toEqual({
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp'
        });
    });

    it('keeps everything after the first slash as the modelId (model ids may contain slashes)', () => {
        expect(splitProviderModel('openrouter/anthropic/claude-sonnet-4-5')).toEqual({
            providerId: 'openrouter',
            modelId: 'anthropic/claude-sonnet-4-5'
        });
    });

    it('returns null for null/undefined input', () => {
        expect(splitProviderModel(null)).toBeNull();
        expect(splitProviderModel(undefined)).toBeNull();
    });

    it('returns null when there is no slash', () => {
        expect(splitProviderModel('no-slash-here')).toBeNull();
    });

    it('returns null for a leading or trailing slash (empty provider or model)', () => {
        expect(splitProviderModel('/model-only')).toBeNull();
        expect(splitProviderModel('provider-only/')).toBeNull();
    });
});

describe('triggerOpencodeCompact', () => {
    it('posts to /session/:id/summarize with the required providerID/modelID payload and no artificial timeout', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/summarize');
            expect(init?.method).toBe('POST');
            expect(JSON.parse(init?.body as string)).toEqual({
                providerID: 'ollama',
                modelID: 'qwen3.6:35b-a3b-q8_0-mtp'
            });
            // `signal` is always attached now (required — see
            // OpencodeCompactCallOpts), but it must not act as a deadline on
            // its own: the caller here never aborts it, so the request must
            // run to completion regardless of how long it legitimately takes
            // (90s+ verified against SER8, 2026-07-30).
            expect(init?.signal).toBe(noSignal);
            // Bun's global fetch() hardcodes a 5-minute idle timeout that
            // fires even with no AbortSignal at all (verified via isolated
            // E2E against SER8, 2026-07-30 — a real ~250s compaction call
            // failed with "The operation timed out"; see oven-sh/bun#16682).
            // The only documented workaround is this Bun-specific,
            // non-standard `timeout: false` fetch option — needed regardless
            // of whether the caller's own `signal` ever fires.
            expect((init as unknown as { timeout?: boolean })?.timeout).toBe(false);
            return new Response(null, { status: 204 });
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ ok: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reports a structured failure when the server responds non-ok (e.g. the v2 compact stub 503)', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            JSON.stringify({ _tag: 'ServiceUnavailableError', message: 'Session compact is not available yet', service: 'session.compact' }),
            { status: 503 }
        ));

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('503');
            expect(result.error).toContain('not available yet');
        }
    });

    it('reports a structured failure when the network call throws', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
    });

    it('URL-encodes the sessionId in the path', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses%20with%20space/summarize');
            return new Response(null, { status: 204 });
        });

        await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses with space',
            providerId: 'ollama',
            modelId: 'model-x',
            fetchImpl,
            signal: noSignal
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('forwards an AbortSignal to fetch when provided, so a caller can interrupt an in-flight request', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.signal).toBe(controller.signal);
            return new Response(null, { status: 204 });
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: controller.signal
        });

        expect(result).toEqual({ ok: true });
    });

    it('resolves with a structured failure (not a hang or uncaught rejection) when the signal aborts mid-request', async () => {
        const controller = new AbortController();
        // Mirrors how a real fetch() rejects on abort: the promise only
        // settles once the signal actually fires, not before.
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        }));

        const resultPromise = triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl,
            signal: controller.signal
        });

        controller.abort();
        const result = await resultPromise;

        expect(result.ok).toBe(false);
    });
});

const marker = (id: string) => ({
    info: { id, role: 'user' },
    parts: [{ type: 'compaction', auto: false }]
});

const summary = (id: string, parentID: string, overrides: Record<string, unknown> = {}, text: string | null = '## Objective\n- Did the thing') => ({
    info: { id, role: 'assistant', parentID, summary: true, finish: 'provider-terminal', ...overrides },
    parts: text === null ? [{ type: 'step-start' }, { type: 'step-finish' }] : [{ type: 'text', text }]
});

describe('captureCompactionMarkerSnapshot', () => {
    it('records only pre-existing manual marker IDs before POST so a later result cannot reuse them', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/message');
            expect(init).toMatchObject({ method: 'GET', signal: noSignal });
            return new Response(JSON.stringify([marker('old-marker')]), { status: 200 });
        });

        await expect(captureCompactionMarkerSnapshot({
            baseUrl: 'http://127.0.0.1:48273', sessionId: 'ses_abc', fetchImpl, signal: noSignal
        })).resolves.toEqual({ markerIds: ['old-marker'] });
    });
});

describe('fetchCompactionResult', () => {
    const options = (messages: unknown[]) => ({
        baseUrl: 'http://127.0.0.1:48273',
        sessionId: 'ses_abc',
        markerIdsBefore: ['old-marker'],
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(messages), { status: 200 })),
        signal: noSignal
    });

    it('succeeds only for the new marker\'s exactly parent-linked terminal summary with nonblank text', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            summary('old-summary', 'old-marker', {}, 'old summary'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker')
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('does not guess between two post-snapshot manual markers', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker'),
            marker('later-manual-marker'),
            summary('later-summary', 'later-manual-marker', {}, 'later summary')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('does not fall back to adjacent text when the new marker has no exact parent-linked assistant result', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('unrelated-summary', 'another-marker')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('keeps a malformed result GET unverified', async () => {
        const result = await fetchCompactionResult({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            markerIdsBefore: ['old-marker'],
            fetchImpl: vi.fn(async () => new Response('not json', { status: 200 })),
            signal: noSignal
        });

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('classifies the observed HTTP-200, finish-unknown, empty linked summary as failed', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', {
                finish: 'unknown',
                tokens: { input: 0, output: 0, reasoning: 0 }
            }, null)
        ]));

        expect(result).toEqual({ status: 'failed', reason: 'OpenCode returned an empty compaction summary.' });
    });

    it('does not use a finish allowlist when terminal evidence and a valid summary are present', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', { finish: 'provider-specific-finish' })
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('concatenates every text part from the exact linked summary', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            {
                info: {
                    id: 'this-request-summary',
                    role: 'assistant',
                    parentID: 'this-request-marker',
                    summary: true,
                    finish: 'provider-terminal'
                },
                parts: [
                    { type: 'text', text: '## Objective\n' },
                    { type: 'step-finish' },
                    { type: 'text', text: '- Did the thing' }
                ]
            }
        ]));

        expect(result).toEqual({ status: 'success', text: '## Objective\n- Did the thing' });
    });

    it('keeps an associated but non-terminal result unverified instead of treating token-less text as a failure', async () => {
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', { finish: undefined }, '')
        ]));

        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('uses OpenCode APIError.data.message as a normalized, truncated safe failure reason without serializing metadata', async () => {
        const providerMessage = ` provider\n unavailable  ${'x'.repeat(220)} `;
        const result = await fetchCompactionResult(options([
            marker('old-marker'),
            marker('this-request-marker'),
            summary('this-request-summary', 'this-request-marker', {
                error: {
                    name: 'APIError',
                    data: {
                        message: providerMessage,
                        apiKey: 'super-secret-api-key',
                        requestHeaders: { authorization: 'Bearer super-secret-token' }
                    }
                }
            }, null)
        ]));

        expect(result).toEqual({ status: 'failed', reason: `provider unavailable ${'x'.repeat(179)}` });
        expect((result as { reason: string }).reason).not.toContain('super-secret');
    });

    it('returns unverified when the semantic-result GET is aborted', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            expect(init?.signal).toBe(controller.signal);
            init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));

        const resultPromise = fetchCompactionResult({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            markerIdsBefore: ['old-marker'],
            fetchImpl,
            signal: controller.signal
        });
        controller.abort();

        await expect(resultPromise).resolves.toEqual({
            status: 'unverified', reason: 'Compaction result could not be verified.'
        });
    });
});

describe('triggerOpencodeCompactV2', () => {
    it('posts to /api/session/:id/compact with Basic auth and the v2.0.29 payload shape', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const signal = new AbortController().signal;
        await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc/1',
            providerId: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            password: 'secret-pw',
            signal,
            fetchImpl
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:48273/api/session/ses_abc%2F1/compact');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization)
            .toBe('Basic ' + Buffer.from('opencode:secret-pw').toString('base64'));
        expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
        // v2.0.29 payload schema is {id?, delivery?} — the session's current
        // model governs server-side, so no provider/model fields are sent.
        expect(JSON.parse(String(init.body))).toEqual({});
    });

    it('encodes the Basic credentials from the OPENCODE_PASSWORD value', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'user:pass@with/special',
            signal: new AbortController().signal,
            fetchImpl
        });
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect((init.headers as Record<string, string>).authorization)
            .toBe('Basic ' + Buffer.from('opencode:user:pass@with/special').toString('base64'));
    });

    it('reports kind rejected with status and body on non-2xx responses', async () => {
        const fetchImpl = vi.fn(async () => new Response('denied', { status: 401 }));
        const rejected = await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: new AbortController().signal,
            fetchImpl
        });
        expect(rejected).toEqual({ kind: 'rejected', error: expect.stringMatching(/401/) });
        const second = await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: new AbortController().signal,
            fetchImpl
        });
        expect(second.kind).toBe('rejected');
    });

    it('treats 5xx as admission-uncertain (recovery, not definitive failure)', async () => {
        const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }));
        const result = await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: new AbortController().signal,
            fetchImpl
        });
        expect(result.kind).toBe('transport-error');
    });

    it('treats 4xx as definitive rejection', async () => {
        const fetchImpl = vi.fn(async () => new Response('denied', { status: 400 }));
        const result = await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: new AbortController().signal,
            fetchImpl
        });
        expect(result.kind).toBe('rejected');
    });

    it('reports kind transport-error on fetch failures (admission uncertain)', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('connection refused');
        });
        const result = await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: new AbortController().signal,
            fetchImpl
        });
        expect(result).toEqual({ kind: 'transport-error', message: 'connection refused' });
    });
});

describe('readOpencodeV2ServerPassword', () => {
    it('extracts OPENCODE_PASSWORD from a parsed /proc environ payload (linux)', async () => {
        const environ = 'PATH=/usr/bin\0HOME=/home/u\0OPENCODE_PASSWORD=abc123\0TERM=xterm\0';
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listDescendantPids: async () => [5150],
            readChildEnviron: async () => environ,
            readChildCmdline: async () => 'opencode\0serve\0--stdio'
        });
        expect(password).toBe('abc123');
    });

    it('returns null when the environ payload has no OPENCODE_PASSWORD', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listDescendantPids: async () => [5150],
            readChildEnviron: async () => 'PATH=/usr/bin\0HOME=/home/u\0'
        });
        expect(password).toBeNull();
    });

    it('returns null when environ parsing fails (read error)', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listDescendantPids: async () => [5150],
            readChildEnviron: async () => {
                throw new Error('ENOENT');
            }
        });
        expect(password).toBeNull();
    });

    it('extracts OPENCODE_PASSWORD from ps Eww output on non-linux platforms (descendants)', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            listDescendantPids: async () => [5150],
            execImpl: async (command, args) => {
                expect(command).toBe('ps');
                expect(args).toEqual(['Eww', '-p', '5150']);
                return '  PID TTY      STAT   TIME COMMAND\n  5150 ?      Ss     0:00 /bin/opencode serve --stdio OPENCODE_PASSWORD=darwin-pw PATH=/usr/bin';
            }
        });
        expect(password).toBe('darwin-pw');
    });

    it('linux path prefers the serve descendant (cmdline) over an inherited-password native child', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listDescendantPids: async () => [111, 222],
            readChildEnviron: async (pid) => pid === 111
                ? 'OPENCODE_PASSWORD=inherited-pw\0PATH=/usr/bin'
                : 'OPENCODE_PASSWORD=generated-pw\0PATH=/usr/bin',
            readChildCmdline: async (pid) => pid === 111
                ? 'opencode\0acp'
                : 'opencode\0serve\0--stdio'
        });
        expect(password).toBe('generated-pw');
    });

    it('linux serve detection requires the exact serve argument, not an executable path substring', async () => {
        // Bot round-5 Minor: an executable under /home/server/ must not flag
        // the acp child as serve.
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'linux',
            listDescendantPids: async () => [111, 222],
            readChildEnviron: async (pid) => pid === 111
                ? 'OPENCODE_PASSWORD=inherited-pw\0PATH=/usr/bin'
                : 'OPENCODE_PASSWORD=generated-pw\0PATH=/usr/bin',
            readChildCmdline: async (pid) => pid === 111
                ? '/home/server/bin/opencode\0acp'
                : 'opencode\0serve\0--stdio'
        });
        expect(password).toBe('generated-pw');
    });

    it('prefers the serve descendant over one that merely inherited OPENCODE_PASSWORD', async () => {
        // Bot round-4 Minor: an npm wrapper tree is wrapper → native acp →
        // serve; a user-exported OPENCODE_PASSWORD is inherited by the
        // native child while serve gets the freshly generated one.
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            listDescendantPids: async () => [111, 222],
            execImpl: async (_command, args) => {
                if (args[2] === '111') {
                    return '  PID TTY      STAT   TIME COMMAND\n  111 ?      Ss     0:00 /bin/opencode acp OPENCODE_PASSWORD=inherited-pw PATH=/usr/bin';
                }
                return '  PID TTY      STAT   TIME COMMAND\n  222 ?      Ss     0:00 /bin/opencode serve --stdio OPENCODE_PASSWORD=generated-pw PATH=/usr/bin';
            }
        });
        expect(password).toBe('generated-pw');
    });

    it('darwin serve detection matches the command portion only, not inherited env values', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            listDescendantPids: async () => [111, 222],
            execImpl: async (_command, args) => {
                if (args[2] === '111') {
                    // Inherited env contains a `serve` substring (e.g. a path
                    // segment) AND the executable path contains 'server' —
                    // neither may flag the acp child as the serve process.
                    return '  PID TTY      STAT   TIME COMMAND\n  111 ?      Ss     0:00 /home/server/bin/opencode acp OPENCODE_PASSWORD=inherited-pw PRESERVE_DIR=/x/serve-cache PATH=/usr/bin';
                }
                return '  PID TTY      STAT   TIME COMMAND\n  222 ?      Ss     0:00 /bin/opencode serve --stdio OPENCODE_PASSWORD=generated-pw PATH=/usr/bin';
            }
        });
        expect(password).toBe('generated-pw');
    });

    it('returns null when pgrep/ps path yields nothing', async () => {
        const password = await readOpencodeV2ServerPassword(4242, {
            platform: 'darwin',
            listDescendantPids: async () => [],
            execImpl: async () => {
                throw new Error('no such process');
            }
        });
        expect(password).toBeNull();
    });
});

describe('triggerOpencodeCompactV2 signal contract', () => {
    it('forwards the caller abort signal to the fetch init', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        await triggerOpencodeCompactV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            providerId: 'p',
            modelId: 'm',
            password: 'pw',
            signal: controller.signal,
            fetchImpl
        });
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(init.signal).toBe(controller.signal);
    });
});

describe('fetchCompactionResultV2', () => {
    const authHeader = () => 'Basic ' + Buffer.from('opencode:pw').toString('base64');

    function fixtureEntry(...entries: unknown[]): Response {
        return new Response(JSON.stringify({ data: entries }), { status: 200 });
    }

    // v2 compaction shape (verified 2026-10-16 against opencode 2.0.29): the
    // compaction entry itself carries `status` and the full `summary` text.
    const completedEntry = (text: string) => ({
        type: 'compaction',
        status: 'completed',
        reason: 'manual',
        summary: text
    });

    it('GETs /api/session/:id/message with Basic auth and unwraps the {data: [...]} response', async () => {
        const fetchImpl = vi.fn(async () => fixtureEntry(completedEntry('v2 summary text')));
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_x/2',
            password: 'pw',
            fetchImpl
        });
        expect(result).toEqual({ status: 'success', text: 'v2 summary text' });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://127.0.0.1:48273/api/session/ses_x%2F2/message');
        expect(init.method).toBe('GET');
        expect((init.headers as Record<string, string>).authorization).toBe(authHeader());
    });

    it('reports failed when the latest compaction entry carries an error status', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => fixtureEntry({ type: 'compaction', status: 'error', reason: 'manual', error: { data: { message: 'provider exploded' } } })
        });
        expect(result).toEqual({ status: 'failed', reason: 'provider exploded' });
    });

    it('reports failed when the completed entry has an empty summary', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => fixtureEntry(completedEntry('   '))
        });
        expect(result).toEqual({ status: 'failed', reason: 'OpenCode returned an empty compaction summary.' });
    });

    it('reports unverified on non-2xx responses', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => new Response('nope', { status: 401 })
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('reports unverified when the response wrapper has no data array', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => new Response(JSON.stringify({ data: null }), { status: 200 })
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('reports unverified when no compaction entry exists yet (pending state)', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => fixtureEntry({ type: 'compaction', status: 'pending', reason: 'manual' })
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('correlates by expectedCompactionId when an older completed compaction precedes it (descending order)', async () => {
        // Measured 2026-10-16: the messages endpoint returns entries newest
        // first, and the compact POST echoes the admitted compaction id.
        const olderCompleted = { id: 'msg_old', type: 'compaction', status: 'completed', reason: 'manual', summary: 'stale summary' };
        const newerPending = { id: 'msg_new', type: 'compaction', status: 'pending', reason: 'manual' };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_new',
            // Descending (newest first), as measured.
            fetchImpl: async () => fixtureEntry(newerPending, olderCompleted)
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });

    it('without a correlation id but with an exclude list, evaluates the single new compaction entry', async () => {
        const olderCompleted = { id: 'msg_old', type: 'compaction', status: 'completed', reason: 'manual', summary: 'stale summary' };
        const newerCompleted = { id: 'msg_new', type: 'compaction', status: 'completed', reason: 'manual', summary: 'fresh summary' };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: null,
            excludeCompactionIds: ['msg_old'],
            // Descending (newest first), as measured.
            fetchImpl: async () => fixtureEntry(newerCompleted, olderCompleted)
        });
        expect(result).toEqual({ status: 'success', text: 'fresh summary' });
    });

    it('a completed entry with an empty summary but a providerContext is a native-compaction success', async () => {
        // Upstream v2 native provider compaction (verified against the v2
        // binary: model.compaction?.type === "native" publishes
        // providerContext instead of summary text) legitimately completes
        // with summary: "".
        const entry = { id: 'msg_native', type: 'compaction', status: 'completed', reason: 'manual', summary: '', providerContext: { version: 1, messages: [] } };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_native',
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'success', text: '' });
    });

    it('a completed entry with an empty summary but a native window is a 2.1-native-compaction success', async () => {
        // OpenCode 2.1 stores a native compaction's replacement window in
        // native.messages (retained messages plus the assistant checkpoint)
        // and still completes with summary: "", which must not be reported as
        // an empty summary.
        const entry = {
            id: 'msg_native21',
            type: 'compaction',
            status: 'completed',
            reason: 'manual',
            summary: '',
            native: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'checkpoint' }] }] }
        };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_native21',
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'success', text: '' });
    });

    it('a completed entry with an empty summary and a native record without a window is a failure', async () => {
        // OpenCode 2.1 only treats a compaction as native when
        // native.messages is present; other native metadata alone does not
        // replace the summary.
        const entry = { id: 'msg_native21_empty', type: 'compaction', status: 'completed', reason: 'manual', summary: '', native: {} };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_native21_empty',
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'failed', reason: 'OpenCode returned an empty compaction summary.' });
    });

    it('reads the v2 top-level error message ({type, message}) as the failure reason', async () => {
        // v2.0.29 session-error shape: { type, message } — safeErrorReason
        // must read the top-level message, not only the v1 data.message.
        const entry = { id: 'msg_fail', type: 'compaction', status: 'failed', reason: 'manual', error: { type: 'compaction.unavailable', message: 'Nothing to compact yet' } };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_fail',
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'failed', reason: 'Nothing to compact yet' });
    });

    it('a completed entry with an empty summary and NO providerContext stays failed', async () => {
        const entry = { id: 'msg_empty', type: 'compaction', status: 'completed', reason: 'manual', summary: '   ' };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: 'msg_empty',
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'failed', reason: 'OpenCode returned an empty compaction summary.' });
    });

    it('an empty exclude snapshot is a valid basis — a fresh session evaluates the single new entry', async () => {
        const entry = { id: 'msg_only', type: 'compaction', status: 'completed', reason: 'manual', summary: 'fresh summary' };
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: null,
            excludeCompactionIds: [],
            fetchImpl: async () => fixtureEntry(entry)
        });
        expect(result).toEqual({ status: 'success', text: 'fresh summary' });
    });

    it('exclude recovery never settles a server auto-compaction as ours', async () => {
        // GLM finding: an auto compaction (reason != manual) racing between
        // admission and the first poll must not be mistaken for ours — its
        // summary would end the wait while OUR manual compaction is pending.
        const autoCompleted = { id: 'msg_auto', type: 'compaction', status: 'completed', reason: 'auto', summary: 'auto summary' };
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            return calls === 1
                ? new Response(JSON.stringify({ data: [autoCompleted] }), { status: 200 })
                : new Response(JSON.stringify({ data: [
                    autoCompleted,
                    { id: 'msg_mine', type: 'compaction', status: 'completed', reason: 'manual', summary: 'mine' }
                ] }), { status: 200 });
        });
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: null,
            excludeCompactionIds: [],
            pollIntervalMs: 1,
            maxAttempts: 5,
            delayImpl: async () => {},
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'success', text: 'mine' });
        expect(calls).toBe(2);
    });

    it('ambiguous recovery ends the poll once ALL candidates are terminal (sawPending must not hold forever)', async () => {
        // Bot round-4 Minor: with a prior pending observation, sawPending
        // disables the stall cap — an all-terminal ambiguous state would
        // poll forever. onAmbiguousTerminal ends it.
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            return calls <= 2
                ? new Response(JSON.stringify({ data: [
                    { id: 'msg_a', type: 'compaction', status: 'pending', reason: 'manual' },
                    { id: 'msg_b', type: 'compaction', status: 'pending', reason: 'manual' }
                ] }), { status: 200 })
                : new Response(JSON.stringify({ data: [
                    { id: 'msg_a', type: 'compaction', status: 'completed', reason: 'manual', summary: 'a done' },
                    { id: 'msg_b', type: 'compaction', status: 'completed', reason: 'manual', summary: 'b done' }
                ] }), { status: 200 });
        });
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: null,
            excludeCompactionIds: [],
            pollIntervalMs: 1,
            maxAttempts: 3,
            delayImpl: async () => {},
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
        expect(calls).toBe(3);
    });

    it('with an exclude list and multiple new entries, stays unverified with pending progress', async () => {
        const first = { id: 'msg_a', type: 'compaction', status: 'pending', reason: 'manual' };
        const second = { id: 'msg_b', type: 'compaction', status: 'pending', reason: 'manual' };
        let pendingCalled = false;
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            expectedCompactionId: null,
            excludeCompactionIds: ['msg_old'],
            onMatchedPending: () => { pendingCalled = true; },
            fetchImpl: async () => fixtureEntry(second, first, { id: 'msg_old', type: 'compaction', status: 'completed', reason: 'manual', summary: 'stale' })
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
        expect(pendingCalled).toBe(true);
    });

    it('reports unverified when the fetch itself throws', async () => {
        const result = await fetchCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            fetchImpl: async () => {
                throw new Error('connection refused');
            }
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
    });
});

describe('pollCompactionResultV2', () => {
    const authHeader = () => 'Basic ' + Buffer.from('opencode:pw').toString('base64');

    function summaryResponse(text: string): Response {
        return new Response(JSON.stringify({
            data: [{ type: 'compaction', status: 'completed', reason: 'manual', summary: text }]
        }), { status: 200 });
    }

    const emptyResponse = () => new Response(JSON.stringify({ data: [] }), { status: 200 });

    it('threads the abort signal into every messages GET', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect((init as { signal?: AbortSignal }).signal).toBe(controller.signal);
            return summaryResponse('done!');
        });
        await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            signal: controller.signal,
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('polls until the status is not unverified (unverified → unverified → success)', async () => {
        const fetchImpl = vi.fn(async () => emptyResponse())
            .mockImplementationOnce(async () => emptyResponse())
            .mockImplementationOnce(async () => emptyResponse())
            .mockImplementationOnce(async () => summaryResponse('done!'));
        const delays: number[] = [];
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_x',
            password: 'pw',
            pollIntervalMs: 5,
            delayImpl: async (ms) => {
                delays.push(ms);
            },
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'success', text: 'done!' });
        expect(delays).toEqual([5, 5]);
    });

    it('returns immediately when the signal aborts while waiting', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async () => emptyResponse());
        const resultPromise = pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 5,
            signal: controller.signal,
            delayImpl: async () => {
                controller.abort();
            },
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        const result = await resultPromise;
        expect(result.status).toBe('unverified');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('returns immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchImpl = vi.fn(async () => emptyResponse());
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 5,
            signal: controller.signal,
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result.status).toBe('unverified');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('pending progress resets the stall cap — visible server work is not force-released', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            // Pending for the first 4 rounds, terminal on the 5th — beyond a
            // cap of 3, which must only count rounds WITHOUT pending progress.
            return calls >= 5
                ? new Response(JSON.stringify({ data: [{ id: 'msg_1', type: 'compaction', status: 'completed', reason: 'manual', summary: 'done' }] }), { status: 200 })
                : new Response(JSON.stringify({ data: [{ id: 'msg_1', type: 'compaction', status: 'pending', reason: 'manual' }] }), { status: 200 });
        });
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 1,
            maxAttempts: 3,
            delayImpl: async () => {},
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'success', text: 'done' });
        expect(calls).toBe(5);
    });

    it('once pending is observed the stall cap never releases the barrier (terminal or teardown ends it)', async () => {
        // GPT finding 2: observation failures after a confirmed pending must
        // not accumulate toward the cap — confirmed server work holds the
        // barrier until terminal or teardown.
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            return calls === 1
                ? new Response(JSON.stringify({ data: [{ id: 'msg_1', type: 'compaction', status: 'pending', reason: 'manual' }] }), { status: 200 })
                : new Response('server exploded', { status: 503 });
        });
        const controller = new AbortController();
        const resultPromise = pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 1,
            maxAttempts: 3,
            signal: controller.signal,
            delayImpl: async () => {
                if (calls >= 6) controller.abort();
            },
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        const result = await resultPromise;
        expect(result.status).toBe('unverified');
        expect(calls).toBeGreaterThanOrEqual(6);
    });

    it('gives up with the last unverified result after maxAttempts (barrier escape)', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
        const delays: number[] = [];
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 1,
            maxAttempts: 3,
            delayImpl: async (ms) => { delays.push(ms); },
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'unverified', reason: 'Compaction result could not be verified.' });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(delays).toEqual([1, 1]);
    });

    it('polls indefinitely without a signal until a terminal status arrives', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            return calls >= 4 ? summaryResponse('late summary') : emptyResponse();
        });
        const result = await pollCompactionResultV2({
            baseUrl: 'http://127.0.0.1:1',
            sessionId: 's',
            password: 'pw',
            pollIntervalMs: 1,
            delayImpl: async () => {},
            fetchImpl: fetchImpl as unknown as typeof fetch
        });
        expect(result).toEqual({ status: 'success', text: 'late summary' });
        expect(calls).toBe(4);
    });
});

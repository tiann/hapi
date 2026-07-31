import { describe, expect, it, vi } from 'vitest';
import { fetchCompactionSummary, splitProviderModel, triggerOpencodeCompact } from './opencodeCompactBridge';

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

describe('fetchCompactionSummary', () => {
    it('extracts the text part of the assistant message that follows the compaction marker (matched via parentID)', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('http://127.0.0.1:48273/session/ses_abc/message');
            return new Response(JSON.stringify([
                { info: { id: 'msg_1', role: 'user' }, parts: [{ id: 'prt_1', type: 'text', text: 'hello' }] },
                { info: { id: 'msg_2', role: 'assistant' }, parts: [{ id: 'prt_2', type: 'text', text: 'hi there' }] },
                { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] },
                {
                    info: { id: 'msg_4', role: 'assistant', parentID: 'msg_3', summary: true },
                    parts: [
                        { id: 'prt_4a', type: 'step-start' },
                        { id: 'prt_4b', type: 'reasoning', text: 'thinking about the summary' },
                        { id: 'prt_4c', type: 'text', text: '## Objective\n- Did the thing' },
                        { id: 'prt_4d', type: 'step-finish' }
                    ]
                }
            ]), { status: 200 });
        });

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: true, text: '## Objective\n- Did the thing' });
    });

    it('falls back to positional adjacency when the assistant message has no parentID', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] },
            { info: { id: 'msg_4', role: 'assistant' }, parts: [{ id: 'prt_4', type: 'text', text: 'summary via positional match' }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: true, text: 'summary via positional match' });
    });

    it('rejects a parentID/positional match whose role is not assistant, even if it happens to carry a text part', async () => {
        // Both the parentID-linked entry AND the positionally-adjacent entry
        // have a `type:'text'` part here, but neither is role:'assistant' —
        // the safe fallback (found:false) must win rather than surfacing
        // whatever unrelated text these entries happen to carry.
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] },
            { info: { id: 'msg_4', role: 'user', parentID: 'msg_3' }, parts: [{ id: 'prt_4', type: 'text', text: 'not actually a summary' }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('concatenates multiple text parts in order instead of only taking the first', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] },
            {
                info: { id: 'msg_4', role: 'assistant', parentID: 'msg_3' },
                parts: [
                    { id: 'prt_4a', type: 'text', text: '## Objective\n' },
                    { id: 'prt_4b', type: 'step-finish' },
                    { id: 'prt_4c', type: 'text', text: '- Did the thing' }
                ]
            }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: true, text: '## Objective\n- Did the thing' });
    });

    it('returns found:false when no compaction marker exists', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_1', role: 'user' }, parts: [{ id: 'prt_1', type: 'text', text: 'hello' }] },
            { info: { id: 'msg_2', role: 'assistant' }, parts: [{ id: 'prt_2', type: 'text', text: 'hi' }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false when the marker is the last message (no following assistant message yet)', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false when the following assistant message has no text part', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'compaction', auto: false }] },
            { info: { id: 'msg_4', role: 'assistant', parentID: 'msg_3' }, parts: [{ id: 'prt_4', type: 'step-finish' }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false on a non-ok response', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false when the response is not valid JSON / not an array', async () => {
        const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false when the network call throws', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        });

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: false });
    });

    it('picks the LAST compaction marker when there are multiple (a session may be compacted more than once)', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
            { info: { id: 'msg_1', role: 'user' }, parts: [{ id: 'prt_1', type: 'compaction', auto: false }] },
            { info: { id: 'msg_2', role: 'assistant', parentID: 'msg_1' }, parts: [{ id: 'prt_2', type: 'text', text: 'first summary' }] },
            { info: { id: 'msg_3', role: 'user' }, parts: [{ id: 'prt_3', type: 'text', text: 'more chat' }] },
            { info: { id: 'msg_4', role: 'user' }, parts: [{ id: 'prt_4', type: 'compaction', auto: false }] },
            { info: { id: 'msg_5', role: 'assistant', parentID: 'msg_4' }, parts: [{ id: 'prt_5', type: 'text', text: 'second summary' }] }
        ]), { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: noSignal
        });

        expect(result).toEqual({ found: true, text: 'second summary' });
    });

    it('forwards an AbortSignal to fetch when provided, so a caller can interrupt an in-flight request', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.signal).toBe(controller.signal);
            return new Response(JSON.stringify([]), { status: 200 });
        });

        await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: controller.signal
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('resolves with found:false (not a hang or uncaught rejection) when the signal aborts mid-request', async () => {
        // Reproduces the exact gap a PR-review round found: the POST
        // (triggerOpencodeCompact) had a signal wired through in an earlier
        // round, but this GET — which runs right after it inside
        // runCompactOperation() — did not, so Stop/switch-to-local could
        // still block on this call even after that fix.
        const controller = new AbortController();
        const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        }));

        const resultPromise = fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl,
            signal: controller.signal
        });

        controller.abort();
        const result = await resultPromise;

        expect(result).toEqual({ found: false });
    });
});

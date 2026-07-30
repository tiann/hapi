import { describe, expect, it, vi } from 'vitest';
import { fetchCompactionSummary, splitProviderModel, triggerOpencodeCompact } from './opencodeCompactBridge';

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
            // No AbortSignal should be attached — the request may legitimately
            // take 90s+ (verified against SER8, 2026-07-30), so callers must
            // not impose a short client-side timeout.
            expect(init?.signal).toBeUndefined();
            return new Response(null, { status: 204 });
        });

        const result = await triggerOpencodeCompact({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            providerId: 'ollama',
            modelId: 'qwen3.6:35b-a3b-q8_0-mtp',
            fetchImpl
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
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
            fetchImpl
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false on a non-ok response', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl
        });

        expect(result).toEqual({ found: false });
    });

    it('returns found:false when the response is not valid JSON / not an array', async () => {
        const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));

        const result = await fetchCompactionSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            fetchImpl
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
            fetchImpl
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
            fetchImpl
        });

        expect(result).toEqual({ found: true, text: 'second summary' });
    });
});

import { describe, expect, it, vi } from 'vitest';
import { splitProviderModel, triggerOpencodeCompact } from './opencodeCompactBridge';

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

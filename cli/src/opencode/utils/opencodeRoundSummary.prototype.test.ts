import { describe, expect, it, vi } from 'vitest';
import { fetchOpencodeRoundSummary } from './opencodeRoundSummary';

describe('OpenCode round model key isolation', () => {
    it('aggregates hostile provider/model identifiers without touching the object prototype', async () => {
        const result = await fetchOpencodeRoundSummary({
            baseUrl: 'http://127.0.0.1:48273',
            sessionId: 'ses_abc',
            promptText: 'prompt',
            snapshot: { messageIds: ['old'] },
            durationMs: 1,
            signal: new AbortController().signal,
            fetchImpl: vi.fn(async () => new Response(JSON.stringify([
                { info: { id: 'old', role: 'user' }, parts: [{ type: 'text', text: 'old' }] },
                { info: { id: 'prompt', role: 'user' }, parts: [{ type: 'text', text: 'prompt' }] },
                {
                    info: {
                        id: 'assistant', role: 'assistant', providerID: '__proto__', modelID: '__proto__', cost: 0,
                        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
                    }
                }
            ]), { status: 200 }))
        });

        expect(result?.summary?.modelUsage).toEqual({
            '__proto__/__proto__': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
        });
        expect(Object.prototype).not.toHaveProperty('inputTokens');
    });
});

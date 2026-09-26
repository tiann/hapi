import { describe, expect, it } from 'vitest';
import { normalizeDecryptedMessage } from './normalize';

describe('OpenCode round summary carrier', () => {
    it('reuses the existing turn-summary normalization contract', () => {
        const normalized = normalizeDecryptedMessage({
            id: 'round-summary',
            seq: 1,
            localId: null,
            createdAt: 1,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'round-summary',
                        summary: {
                            usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 },
                            modelUsage: {
                                'openai/gpt-5.4': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 90, cacheCreationInputTokens: 10 }
                            },
                            total_cost_usd: 0.034,
                            num_turns: 2,
                            duration_ms: 1_250
                        }
                    }
                }
            }
        });

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'turn-summary',
                summary: {
                    modelUsage: {
                        'openai/gpt-5.4': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 90, cacheCreationInputTokens: 10 }
                    },
                    totalCostUsd: 0.034,
                    numTurns: 2,
                    durationMs: 1_250
                }
            }
        });
    });

    it('fails closed for incomplete OpenCode aggregates while preserving permissive legacy summaries', () => {
        const valid = {
            usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
            modelUsage: { 'fixture/model': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } },
            num_turns: 1,
            duration_ms: 0
        }
        const normalizeCarrier = (summary: unknown) => normalizeDecryptedMessage({
            id: 'strict-round-summary', seq: 1, localId: null, createdAt: 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary } } }
        })

        expect(normalizeCarrier(valid)).not.toBeNull()
        for (const malformed of [
            {},
            { ...valid, usage: undefined },
            { ...valid, modelUsage: {} },
            { ...valid, modelUsage: { 'fixture/model': { inputTokens: 1 } } },
            { ...valid, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } },
            { ...valid, num_turns: 0 },
            { ...valid, duration_ms: Infinity },
            { ...valid, total_cost_usd: 0 },
            { ...valid, total_cost_usd: Number.NaN },
            { ...valid, modelUsage: [valid.modelUsage['fixture/model']] },
            { ...valid, modelUsage: { 'fixture/model': Object.assign([], valid.modelUsage['fixture/model']) } },
            Object.assign([], valid)
        ]) {
            expect(normalizeCarrier(malformed)).toBeNull()
        }

        const legacy = normalizeDecryptedMessage({
            id: 'legacy-turn-duration', seq: 2, localId: null, createdAt: 2,
            content: { role: 'agent', content: { type: 'output', data: { type: 'system', subtype: 'turn_duration', resultSummary: { duration_ms: 5 } } } }
        })
        expect(legacy).toMatchObject({ content: { type: 'turn-summary', summary: { durationMs: 5 } } })
    })
});

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
                            duration_ms: 1_250,
                            generation_ms: 500,
                            generation_output_tokens: 25
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
                    durationMs: 1_250,
                    generationMs: 500,
                    generationOutputTokens: 25
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


it('omits only the throughput pair for absent, partial or invalid optional generation data', () => {
    const valid = {
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { 'fixture/model': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        num_turns: 1, duration_ms: 100
    }
    for (const generation of [
        {}, { generation_ms: 1 }, { generation_output_tokens: 2 },
        ...[0, -1, NaN, Infinity, '5', 0.5, Number.MAX_SAFE_INTEGER + 1].flatMap(value => [
            { generation_ms: value, generation_output_tokens: 2 },
            { generation_ms: 10, generation_output_tokens: value }
        ])
    ]) {
        const normalized = normalizeDecryptedMessage({
            id: 'summary', seq: 1, localId: null, createdAt: 1,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary: { ...valid, ...generation } } } }
        })
        expect(normalized).toMatchObject({ content: { type: 'turn-summary', summary: { durationMs: 100, numTurns: 1 } } })
        expect(normalized?.content).not.toHaveProperty('summary.generationMs')
        expect(normalized?.content).not.toHaveProperty('summary.generationOutputTokens')
    }
})

describe('agy round summary carrier', () => {
    const normalizeCarrier = (summary: unknown) => normalizeDecryptedMessage({
        id: 'agy-round-summary', seq: 1, localId: null, createdAt: 1,
        content: { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary } } }
    })

    it('keeps the agy usage breakdown, model and round time', () => {
        expect(normalizeCarrier({
            provider: 'agy',
            model: 'gemini-3-flash-low',
            agy_usage: { input_tokens: 30458, output_tokens: 58, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 30516 },
            duration_ms: 9_500
        })).toMatchObject({
            role: 'event',
            content: {
                type: 'turn-summary',
                summary: {
                    provider: 'agy',
                    modelUsage: { 'gemini-3-flash-low': {} },
                    agyUsage: { input_tokens: 30458, output_tokens: 58, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 30516 },
                    durationMs: 9_500
                }
            }
        })
    })

    it('keeps agy generation time and tokens only when both are positive', () => {
        const base = { provider: 'agy', agy_usage: { output_tokens: 70 }, duration_ms: 14_900 }
        expect(normalizeCarrier({ ...base, generation_ms: 2_500, generation_output_tokens: 70 })?.content)
            .toMatchObject({ summary: { generationMs: 2_500, generationOutputTokens: 70 } })
        for (const generation of [{}, { generation_ms: 0, generation_output_tokens: 70 }, { generation_ms: 2_500 }, { generation_ms: -1, generation_output_tokens: 70 }]) {
            expect(normalizeCarrier({ ...base, ...generation })?.content).not.toHaveProperty('summary.generationMs')
        }
    })

    it('drops invalid token counts and empty agy summaries', () => {
        const normalized = normalizeCarrier({
            provider: 'agy',
            agy_usage: { input_tokens: -1, output_tokens: 1.5, thinking_tokens: '3', cache_read_tokens: 2, total_tokens: Number.MAX_SAFE_INTEGER + 1 }
        })
        expect(normalized?.content).toEqual({
            type: 'turn-summary',
            summary: { provider: 'agy', modelUsage: {}, agyUsage: { cache_read_tokens: 2 } }
        })
        expect(normalizeCarrier({ provider: 'agy', agy_usage: { input_tokens: -1 } })).toBeNull()
        expect(normalizeCarrier({ provider: 'agy', agy_usage: [1, 2] })).toBeNull()
    })
})

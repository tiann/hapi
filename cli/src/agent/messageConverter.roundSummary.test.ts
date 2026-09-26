import { describe, expect, it } from 'vitest';
import { convertAgentMessage } from './messageConverter';

describe('convertAgentMessage round summary', () => {
    it('converts the generic carrier into the HAPI-owned round-summary wire contract', () => {
        const converted = convertAgentMessage({
            type: 'round_summary',
            summary: {
                usage: { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 90, cacheCreationInputTokens: 10 },
                modelUsage: {
                    'openai/gpt-5.4': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 90, cacheCreationInputTokens: 10 }
                },
                totalCostUsd: 0.034,
                numTurns: 2,
                durationMs: 1_250
            }
        } as never);

        expect(converted).toEqual({
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
        });
    });
});

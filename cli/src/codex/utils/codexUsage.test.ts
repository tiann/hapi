import { describe, expect, it } from 'vitest';
import {
    createReplayUsageAccumulator,
    filterTranscriptUsageForLive,
    markLiveUsageDimensions,
    normalizeCodexUsage,
    normalizeCodexUsageUpdate,
    noteReplayUsageSample,
    orderedReplayUsagePayloads
} from './codexUsage';

describe('normalizeCodexUsage', () => {
    it('parses camelCase app-server RateLimitWindow fields', () => {
        const usage = normalizeCodexUsage({
            rate_limits: {
                primary: {
                    usedPercent: 12,
                    windowDurationMins: 300,
                    resetsAt: 1_774_278_000
                },
                secondary: {
                    usedPercent: 4,
                    windowDurationMins: 10080,
                    resetsAt: 1_775_140_800
                },
                credits: { hasCredits: true, unlimited: false, balance: '0.0000000000' }
            }
        }, { now: 1_000_000 });

        expect(usage).toMatchObject({
            rateLimits: {
                fiveHour: {
                    usedPercent: 12,
                    windowMinutes: 300,
                    resetAt: 1_774_278_000_000
                },
                weekly: {
                    usedPercent: 4,
                    windowMinutes: 10080,
                    resetAt: 1_775_140_800_000
                }
            },
            credits: { hasCredits: true, unlimited: false, balance: '0.0000000000' }
        });
    });

    it('parses app-server token usage with context and rate-limit buckets', () => {
        const usage = normalizeCodexUsage({
            model_context_window: 200_000,
            used_tokens: 35_000,
            total_token_usage: {
                input_tokens: 10_000,
                cached_input_tokens: 20_000,
                output_tokens: 3_000,
                reasoning_output_tokens: 2_000,
                total_tokens: 35_000
            },
            last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 200,
                output_tokens: 30,
                reasoning_output_tokens: 20,
                total_tokens: 350
            },
            rate_limits: {
                primary: {
                    used_percent: 42.5,
                    window_minutes: 300,
                    resets_in_seconds: 600
                },
                secondary: {
                    used_percent: 9,
                    window_minutes: 10080,
                    reset_at: '2026-04-28T00:00:00.000Z'
                }
            }
        }, { now: 1_000_000 });

        expect(usage).toMatchObject({
            contextWindow: {
                usedTokens: 35_000,
                limitTokens: 200_000,
                percent: 17.5,
                updatedAt: 1_000_000
            },
            rateLimits: {
                fiveHour: {
                    usedPercent: 42.5,
                    windowMinutes: 300,
                    resetAt: 1_600_000
                },
                weekly: {
                    usedPercent: 9,
                    windowMinutes: 10080,
                    resetAt: Date.parse('2026-04-28T00:00:00.000Z')
                }
            },
            totalTokenUsage: {
                inputTokens: 10_000,
                cachedInputTokens: 20_000,
                outputTokens: 3_000,
                reasoningOutputTokens: 2_000,
                totalTokens: 35_000
            },
            lastTokenUsage: {
                inputTokens: 100,
                cachedInputTokens: 200,
                outputTokens: 30,
                reasoningOutputTokens: 20,
                totalTokens: 350
            }
        });
    });

    it('falls back to input+output when total_tokens is omitted (cached/reasoning are subsets)', () => {
        const usage = normalizeCodexUsage({
            info: {
                model_context_window: 100_000,
                total_token_usage: {
                    input_tokens: 1000,
                    cached_input_tokens: 400,
                    output_tokens: 250,
                    reasoning_output_tokens: 100
                }
            }
        }, { now: 3_000_000 });

        expect(usage?.totalTokenUsage).toMatchObject({
            inputTokens: 1000,
            cachedInputTokens: 400,
            outputTokens: 250,
            reasoningOutputTokens: 100,
            totalTokens: 1250
        });
        expect(usage?.contextWindow?.usedTokens).toBe(1250);
    });

    it('parses transcript token_count info with sibling rate limits', () => {
        const usage = normalizeCodexUsage({
            info: {
                model_context_window: 100_000,
                total_token_usage: {
                    input_tokens: 1000,
                    cached_input_tokens: 500,
                    output_tokens: 250,
                    reasoning_output_tokens: 250,
                    total_tokens: 2000
                }
            },
            rate_limits: {
                primary: {
                    used_percent: 80,
                    window_minutes: 300
                }
            }
        }, { now: 2_000_000 });

        expect(usage?.contextWindow).toMatchObject({
            usedTokens: 2000,
            limitTokens: 100_000,
            percent: 2
        });
        expect(usage?.rateLimits.fiveHour).toMatchObject({
            usedPercent: 80,
            windowMinutes: 300
        });
    });

    it('uses last token usage for context window when cumulative total exceeds the model window', () => {
        const usage = normalizeCodexUsage({
            info: {
                model_context_window: 258_400,
                total_token_usage: {
                    input_tokens: 2_767_000,
                    cached_input_tokens: 2_509_000,
                    output_tokens: 20_000,
                    reasoning_output_tokens: 3_000,
                    total_tokens: 2_787_000
                },
                last_token_usage: {
                    input_tokens: 75_918,
                    cached_input_tokens: 46_976,
                    output_tokens: 542,
                    reasoning_output_tokens: 52,
                    total_tokens: 76_460
                }
            }
        }, { now: 2_000_000 });

        expect(usage?.contextWindow).toMatchObject({
            usedTokens: 76_460,
            limitTokens: 258_400,
            percent: (76_460 / 258_400) * 100
        });
        expect(usage?.totalTokenUsage?.totalTokens).toBe(2_787_000);
    });

    it('returns null when no supported usage fields are present', () => {
        expect(normalizeCodexUsage({ message: 'hello' })).toBeNull();
    });

    it('extracts credits + plan metadata for premium-credits accounts with both windows null', () => {
        // Shape captured from a live Codex Pro account whose 5h subscription
        // window AND topped-up credits are both exhausted (rollout JSONL,
        // 2026-06-08). primary/secondary are explicitly null because the
        // plan no longer bills by window; the constraint is credits.balance.
        const usage = normalizeCodexUsage({
            info: {
                model_context_window: 258_400,
                total_token_usage: {
                    input_tokens: 51_733_893,
                    cached_input_tokens: 50_161_280,
                    output_tokens: 74_915,
                    reasoning_output_tokens: 27_228,
                    total_tokens: 51_808_808
                },
                last_token_usage: {
                    input_tokens: 206_333,
                    cached_input_tokens: 205_696,
                    output_tokens: 41,
                    reasoning_output_tokens: 0,
                    total_tokens: 206_374
                }
            },
            rate_limits: {
                limit_id: 'premium',
                limit_name: null,
                primary: null,
                secondary: null,
                credits: {
                    has_credits: false,
                    unlimited: false,
                    balance: '0'
                },
                plan_type: null,
                rate_limit_reached_type: null
            }
        }, { now: 3_000_000 });

        expect(usage?.rateLimits.fiveHour).toBeUndefined();
        expect(usage?.rateLimits.weekly).toBeUndefined();
        expect(usage?.credits).toEqual({
            hasCredits: false,
            unlimited: false,
            balance: '0'
        });
        expect(usage?.limitId).toBe('premium');
        // plan_type and rate_limit_reached_type were null in the captured
        // shape - those should drop out instead of surfacing as 'null'.
        expect(usage?.planType).toBeUndefined();
        expect(usage?.rateLimitReachedType).toBeUndefined();
    });

    it('preserves rate_limit_reached_type when codex flags an explicit cap', () => {
        const usage = normalizeCodexUsage({
            info: { model_context_window: 100_000 },
            rate_limits: {
                limit_id: 'plus',
                plan_type: 'plus',
                primary: { used_percent: 100, window_minutes: 300 },
                secondary: { used_percent: 100, window_minutes: 10080 },
                credits: null,
                rate_limit_reached_type: 'weekly'
            }
        });

        expect(usage?.rateLimitReachedType).toBe('weekly');
        expect(usage?.planType).toBe('plus');
        expect(usage?.limitId).toBe('plus');
        expect(usage?.credits).toBeUndefined();
    });

    it('surfaces a non-blocking unlimited credit balance without exhausting flags', () => {
        const usage = normalizeCodexUsage({
            info: { model_context_window: 100_000 },
            rate_limits: {
                credits: { has_credits: true, unlimited: true, balance: '0' }
            }
        });

        expect(usage?.credits).toEqual({
            hasCredits: true,
            unlimited: true,
            balance: '0'
        });
    });

    it('marks rate-limit presence when the payload includes rate_limits (even null)', () => {
        expect(normalizeCodexUsageUpdate({
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1000 }
            },
            rate_limits: null
        })?.hasRateLimitSnapshot).toBe(true);

        expect(normalizeCodexUsageUpdate({
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1000 }
            }
        })?.hasRateLimitSnapshot).toBe(false);
    });

    it('accepts rate-limits-only / null snapshots so clears still apply', () => {
        expect(normalizeCodexUsageUpdate({
            info: { rate_limits: null }
        })).toMatchObject({
            usage: { rateLimits: {} },
            hasRateLimitSnapshot: true,
            presentRateLimitBuckets: { fiveHour: true, weekly: true }
        });

        expect(normalizeCodexUsageUpdate({
            info: {
                rate_limits: {
                    primary: { used_percent: 55, window_minutes: 300 },
                    secondary: { used_percent: 12, window_minutes: 10080 }
                }
            }
        })).toMatchObject({
            usage: {
                rateLimits: {
                    fiveHour: { usedPercent: 55, windowMinutes: 300 },
                    weekly: { usedPercent: 12, windowMinutes: 10080 }
                }
            },
            hasRateLimitSnapshot: true,
            presentRateLimitBuckets: { fiveHour: true, weekly: true }
        });
    });

    it('treats array rate_limits snapshots as a full bucket replace', () => {
        expect(normalizeCodexUsageUpdate({
            rate_limits: [
                { used_percent: 20, window_minutes: 300 },
                { used_percent: 8, window_minutes: 10080 }
            ]
        })).toMatchObject({
            hasRateLimitSnapshot: true,
            presentRateLimitBuckets: { fiveHour: true, weekly: true },
            usage: {
                rateLimits: {
                    fiveHour: { usedPercent: 20, windowMinutes: 300 },
                    weekly: { usedPercent: 8, windowMinutes: 10080 }
                }
            }
        });
    });

    it('coalesces replay samples by dimension while preserving order', () => {
        const accumulator = createReplayUsageAccumulator();
        const tokensOnly = {
            type: 'token_count',
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200 }
            }
        };
        const rateLimitsOnly = {
            type: 'token_count',
            info: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } }
        };
        const laterTokens = {
            type: 'token_count',
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1500, input_tokens: 1200, output_tokens: 300 }
            }
        };

        noteReplayUsageSample(accumulator, tokensOnly);
        noteReplayUsageSample(accumulator, rateLimitsOnly);
        noteReplayUsageSample(accumulator, laterTokens);

        expect(orderedReplayUsagePayloads(accumulator)).toEqual([rateLimitsOnly, laterTokens]);
    });

    it('filters transcript payloads per live dimension', () => {
        const mixed = {
            type: 'token_count',
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200 },
                rate_limits: { primary: { used_percent: 99, window_minutes: 300 } }
            }
        };

        expect(filterTranscriptUsageForLive(mixed, { tokens: false, rateLimits: true })).toEqual({
            type: 'token_count',
            info: {
                model_context_window: 100_000,
                total_token_usage: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200 }
            }
        });
        expect(filterTranscriptUsageForLive(mixed, { tokens: true, rateLimits: true })).toBeNull();
        expect(markLiveUsageDimensions(undefined, {
            type: 'token_count',
            usage_scope: 'account',
            info: { rate_limits: { primary: { used_percent: 12, window_minutes: 300 } } }
        })).toEqual({ tokens: false, rateLimits: true });
    });
});

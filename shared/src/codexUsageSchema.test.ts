import { describe, expect, it } from 'vitest'
import { MetadataSchema } from './schemas'

describe('MetadataSchema codexUsage', () => {
    it('accepts structured Codex usage metadata', () => {
        const parsed = MetadataSchema.safeParse({
            path: '/repo',
            host: 'machine',
            flavor: 'codex',
            codexUsage: {
                contextWindow: {
                    usedTokens: 2000,
                    limitTokens: 100_000,
                    percent: 2,
                    updatedAt: 1
                },
                rateLimits: {
                    fiveHour: {
                        usedPercent: 25,
                        windowMinutes: 300,
                        resetAt: 2
                    }
                },
                totalTokenUsage: {
                    inputTokens: 1000,
                    cachedInputTokens: 500,
                    outputTokens: 250,
                    reasoningOutputTokens: 250,
                    totalTokens: 2000
                }
            }
        })

        expect(parsed.success).toBe(true)
        expect(parsed.success ? parsed.data.codexUsage : undefined).toMatchObject({
            contextWindow: {
                usedTokens: 2000,
                limitTokens: 100_000,
                percent: 2
            }
        })
    })

    it('accepts premium-credits Codex metadata (credits + reached-type + plan fields)', () => {
        const parsed = MetadataSchema.safeParse({
            path: '/repo',
            host: 'machine',
            flavor: 'codex',
            codexUsage: {
                contextWindow: {
                    usedTokens: 206_000,
                    limitTokens: 258_400,
                    percent: 80,
                    updatedAt: 1
                },
                rateLimits: {},
                credits: { hasCredits: false, unlimited: false, balance: '0' },
                rateLimitReachedType: 'weekly',
                planType: 'pro',
                limitId: 'premium'
            }
        })

        expect(parsed.success).toBe(true)
        const codexUsage = parsed.success ? parsed.data.codexUsage : undefined
        expect(codexUsage?.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' })
        expect(codexUsage?.rateLimitReachedType).toBe('weekly')
        expect(codexUsage?.planType).toBe('pro')
        expect(codexUsage?.limitId).toBe('premium')
    })
})

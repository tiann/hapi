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
})

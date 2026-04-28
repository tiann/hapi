import { describe, expect, it } from 'vitest'
import type { CodexUsage } from '@hapi/protocol/types'
import {
    formatCodexUsageReset,
    getCodexUsageRingPercent,
    getCodexUsageRows
} from './codexUsageDisplay'

describe('codexUsageDisplay', () => {
    it('prefers context window percent for the ring', () => {
        const usage: CodexUsage = {
            contextWindow: {
                usedTokens: 20_000,
                limitTokens: 100_000,
                percent: 20,
                updatedAt: 1
            },
            rateLimits: {
                fiveHour: {
                    usedPercent: 80,
                    windowMinutes: 300
                }
            }
        }

        expect(getCodexUsageRingPercent(usage)).toBe(20)
    })

    it('falls back to the highest rate-limit usage for the ring', () => {
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: {
                    usedPercent: 30,
                    windowMinutes: 300
                },
                weekly: {
                    usedPercent: 60,
                    windowMinutes: 10080
                }
            }
        }

        expect(getCodexUsageRingPercent(usage)).toBe(60)
    })

    it('formats detail rows and reset times', () => {
        const usage: CodexUsage = {
            contextWindow: {
                usedTokens: 2_000,
                limitTokens: 10_000,
                percent: 20,
                updatedAt: 1
            },
            rateLimits: {
                fiveHour: {
                    usedPercent: 50,
                    windowMinutes: 300,
                    resetAt: Date.UTC(2026, 3, 27, 12, 0, 0)
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

        expect(getCodexUsageRows(usage).map((row) => row.label)).toEqual([
            'Context Window',
            '5h Usage',
            'Token Breakdown'
        ])
        expect(formatCodexUsageReset(Date.UTC(2026, 3, 27, 12, 0, 0), 'en-US')).toContain('12:00')
    })

    it('returns null when no usage is displayable', () => {
        expect(getCodexUsageRingPercent({ rateLimits: {} })).toBeNull()
    })
})

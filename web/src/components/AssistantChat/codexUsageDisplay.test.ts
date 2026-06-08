import { describe, expect, it } from 'vitest'
import type { CodexUsage } from '@hapi/protocol/types'
import {
    formatCodexUsageReset,
    getCodexUsageRingPercent,
    getCodexUsageRows,
    isCodexUsageBlocked
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
        expect(formatCodexUsageReset(Date.UTC(2026, 3, 27, 12, 0, 0), 'en-US')).toMatch(/Apr 27/)
    })

    it('returns null when no usage is displayable', () => {
        expect(getCodexUsageRingPercent({ rateLimits: {} })).toBeNull()
    })

    it('forces 100% ring + critical Credits row when subscription + credits both exhausted', () => {
        // Pro account, 5h + weekly windows both depleted (primary/secondary
        // become null upstream), credits topped-up but spent to 0. Without
        // this branch the ring would read context-window-only (e.g. 80%)
        // and silently misrepresent "blocked" as "plenty of room left".
        const usage: CodexUsage = {
            contextWindow: {
                usedTokens: 206_000,
                limitTokens: 258_400,
                percent: 80,
                updatedAt: 1
            },
            rateLimits: {},
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            limitId: 'premium'
        }

        expect(isCodexUsageBlocked(usage)).toBe(true)
        expect(getCodexUsageRingPercent(usage)).toBe(100)

        const rows = getCodexUsageRows(usage)
        const creditsRow = rows.find((row) => row.label === 'Credits')
        expect(creditsRow?.value).toBe('$0')
        expect(creditsRow?.severity).toBe('critical')
        expect(creditsRow?.detail).toBe('subscription / top-up exhausted')
    })

    it('renders Limit Reached header when codex emits rate_limit_reached_type', () => {
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 100, windowMinutes: 300 }
            },
            rateLimitReachedType: 'weekly'
        }

        const rows = getCodexUsageRows(usage)
        expect(rows[0]).toEqual(expect.objectContaining({
            label: 'Limit Reached',
            value: 'Weekly',
            severity: 'critical'
        }))
        expect(isCodexUsageBlocked(usage)).toBe(true)
    })

    it('does not flag blocked when credits.unlimited is true even if balance reads 0', () => {
        const usage: CodexUsage = {
            rateLimits: {},
            credits: { hasCredits: true, unlimited: true, balance: '0' }
        }
        expect(isCodexUsageBlocked(usage)).toBe(false)
        const rows = getCodexUsageRows(usage)
        const creditsRow = rows.find((row) => row.label === 'Credits')
        expect(creditsRow?.value).toBe('Unlimited')
        expect(creditsRow?.severity).toBeUndefined()
    })
})

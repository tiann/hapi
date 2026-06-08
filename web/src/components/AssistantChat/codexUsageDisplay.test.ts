import { describe, expect, it } from 'vitest'
import type { CodexUsage } from '@hapi/protocol/types'
import {
    formatCodexUsageReset,
    getCodexUsageRing,
    getCodexUsageRingPercent,
    getCodexUsageRingTitle,
    getCodexUsageRows,
    isCodexUsageBlocked
} from './codexUsageDisplay'

describe('codexUsageDisplay', () => {
    it('surfaces the most-pressing axis - rate limit beats lower context fill', () => {
        // Reproduces the bug screenshot from 2026-06-09: ctx=80% but
        // weekly=100%. Original PR #537 preferred context and silently
        // hid the hard weekly cap behind a softer context reading. Ring
        // must report 100 + axis='weekly' so the popover dominant-marker
        // and ring colour both reflect the real constraint.
        const usage: CodexUsage = {
            contextWindow: {
                usedTokens: 207_000,
                limitTokens: 258_400,
                percent: 80,
                updatedAt: 1
            },
            rateLimits: {
                fiveHour: { usedPercent: 1, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            }
        }

        const ring = getCodexUsageRing(usage)
        expect(ring).toEqual({ percent: 100, axis: 'weekly' })
        expect(getCodexUsageRingPercent(usage)).toBe(100)
        expect(getCodexUsageRingTitle(ring!, usage)).toContain('Weekly')
    })

    it('reports context when context dominates the rate-limit axes', () => {
        const usage: CodexUsage = {
            contextWindow: {
                usedTokens: 80_000,
                limitTokens: 100_000,
                percent: 80,
                updatedAt: 1
            },
            rateLimits: {
                fiveHour: { usedPercent: 20, windowMinutes: 300 },
                weekly: { usedPercent: 30, windowMinutes: 10080 }
            }
        }
        expect(getCodexUsageRing(usage)).toEqual({ percent: 80, axis: 'context' })
    })

    it('falls back to the highest rate-limit usage when context is absent', () => {
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 30, windowMinutes: 300 },
                weekly: { usedPercent: 60, windowMinutes: 10080 }
            }
        }

        expect(getCodexUsageRing(usage)).toEqual({ percent: 60, axis: 'weekly' })
    })

    it('marks the dominant row so the popover can highlight the axis driving the ring', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 207_000, limitTokens: 258_400, percent: 80, updatedAt: 1 },
            rateLimits: {
                fiveHour: { usedPercent: 1, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            }
        }
        const rows = getCodexUsageRows(usage)
        const dominant = rows.filter((r) => r.dominant)
        expect(dominant.map((r) => r.label)).toEqual(['1 Week Usage'])
        expect(rows.find((r) => r.label === 'Context Window')?.dominant).toBeFalsy()
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
        expect(creditsRow?.value).toBe('0')
        expect(creditsRow?.severity).toBe('critical')
        expect(creditsRow?.detail).toBe('subscription / top-up exhausted')
    })

    it('formats credit balances without $ prefix and trims trailing zeros', () => {
        // Codex sends balance as a precision-preserving string. Real
        // payloads observed: '0' (empty), '250.0000000000' (just topped
        // up $250), '0.0000000000' (also empty). All three must render
        // cleanly without a $ prefix or trailing zero noise.
        const cases: Array<{ raw: string; expected: string; blocked: boolean }> = [
            { raw: '0', expected: '0', blocked: true },
            { raw: '0.0000000000', expected: '0', blocked: true },
            { raw: '250.0000000000', expected: '250', blocked: false },
            { raw: '12.345', expected: '12.35', blocked: false }
        ]
        for (const { raw, expected, blocked } of cases) {
            const usage: CodexUsage = {
                rateLimits: {},
                credits: { hasCredits: !blocked, unlimited: false, balance: raw }
            }
            const rows = getCodexUsageRows(usage)
            const creditsRow = rows.find((row) => row.label === 'Credits')
            expect(creditsRow?.value, `balance="${raw}"`).toBe(expected)
            expect(isCodexUsageBlocked(usage), `balance="${raw}"`).toBe(blocked)
        }
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

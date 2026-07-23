import { describe, expect, it } from 'vitest'
import type { CodexUsage } from '@hapi/protocol/types'
import { toCodexBudgetState } from './codexBudgetAdapter'

describe('toCodexBudgetState', () => {
    it('returns null when usage is empty', () => {
        expect(toCodexBudgetState(null)).toBeNull()
        expect(toCodexBudgetState(undefined)).toBeNull()
        expect(toCodexBudgetState({ rateLimits: {} })).toBeNull()
    })

    it('builds a healthy state from a fresh Plus account', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 20_000, limitTokens: 100_000, percent: 20, updatedAt: 1 },
            rateLimits: {
                fiveHour: { usedPercent: 30, windowMinutes: 300 },
                weekly: { usedPercent: 10, windowMinutes: 10080 }
            }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('green')
        expect(state?.operationalAxisId).toBe('context')
        expect(state?.dominantAxisId).toBe('fiveHour')
        expect(state?.axes.map((axis) => axis.id)).toEqual(['context', 'fiveHour', 'weekly'])
    })

    it('flags amber when context fills past 60% with no rate-limit pressure', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 70_000, limitTokens: 100_000, percent: 70, updatedAt: 1 },
            rateLimits: {}
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('amber')
        expect(state?.dominantAxisId).toBe('context')
    })

    it('flags red when any axis crosses 95% (subscription cap with no credits to cover)', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 20_000, limitTokens: 100_000, percent: 20, updatedAt: 1 },
            rateLimits: {
                fiveHour: { usedPercent: 5, windowMinutes: 300 },
                weekly: { usedPercent: 96, windowMinutes: 10080 }
            }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('red')
        expect(state?.dominantAxisId).toBe('weekly')
        expect(state?.effectiveReason).toContain('1 Week Usage')
    })

    it('flags amber covering when weekly is at 100% but credits remain (Pro account)', () => {
        // This is the operator's actual state on 2026-06-09: weekly=100%
        // (subscription window exhausted) but credits=246 available, so
        // codex falls back to credit-billing. Previous design rendered
        // red 100, which was technically true (weekly is capped) but
        // operationally misleading (user can still send).
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 207_000, limitTokens: 258_400, percent: 80, updatedAt: 1 },
            rateLimits: {
                fiveHour: { usedPercent: 1, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            },
            credits: { hasCredits: true, unlimited: false, balance: '246.0000000000' },
            limitId: 'premium'
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('amber')
        expect(state?.effectiveReason).toContain('credits covering')
        expect(state?.operationalAxisId).toBe('context')
        // Dominant should still be weekly (highest-pressure non-credits axis)
        expect(state?.dominantAxisId).toBe('weekly')
        const creditsAxis = state?.axes.find((axis) => axis.id === 'credits')
        expect(creditsAxis?.covering).toBe(true)
        expect(creditsAxis?.valueText).toBe('246')
    })

    it('keeps worst active constraint red when credits cover a capped window but context is near full', () => {
        // Bot Major 2026-07-23: covering-amber must not short-circuit before
        // context (or any other non-covered axis) at >=95% can paint red.
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 255_000, limitTokens: 258_400, percent: 99, updatedAt: 1 },
            rateLimits: {
                fiveHour: { usedPercent: 10, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            },
            credits: { hasCredits: true, unlimited: false, balance: '50.0000000000' },
            limitId: 'premium'
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('red')
        expect(state?.effectiveReason).toContain('Context Window')
        expect(state?.operationalAxisId).toBe('context')
        const creditsAxis = state?.axes.find((axis) => axis.id === 'credits')
        expect(creditsAxis?.covering).toBe(true)
    })

    it('flags blocked when subscription + credits both exhausted', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 207_000, limitTokens: 258_400, percent: 80, updatedAt: 1 },
            rateLimits: {},
            credits: { hasCredits: false, unlimited: false, balance: '0' },
            limitId: 'premium'
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('blocked')
        // Dominant: credits (pressure 100, critical)
        expect(state?.dominantAxisId).toBe('credits')
        const creditsAxis = state?.axes.find((axis) => axis.id === 'credits')
        expect(creditsAxis?.critical).toBe(true)
        expect(creditsAxis?.valueText).toBe('0')
        // Operational axis stays as context (centre number = how-much-room-for-task)
        expect(state?.operationalAxisId).toBe('context')
    })

    it('flags blocked during the transition shape (both windows at 100, credits 0, windows still present)', () => {
        // Cold-review finding 2026-06-09: before codex nulls out the
        // exhausted windows it briefly emits both primary AND secondary
        // with usedPercent=100 alongside credits.has_credits=false.
        // Earlier logic only treated 'windows absent' as blocked, missing
        // this transition shape - effective state landed as 'red' with
        // generic 'Credits 100%' reason instead of the explicit 'Blocked'.
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 100, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            },
            credits: { hasCredits: false, unlimited: false, balance: '0' }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('blocked')
        expect(state?.effectiveReason).toContain('Blocked')
    })

    it('does not flag blocked when only one window is capped (the other still has room)', () => {
        // 5h at cap during weekly reset window - user can still send via
        // the weekly bucket. Should be red (5h at cap) not blocked.
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 100, windowMinutes: 300 },
                weekly: { usedPercent: 30, windowMinutes: 10080 }
            },
            credits: { hasCredits: false, unlimited: false, balance: '0' }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('red')
    })

    it('flags blocked with the codex reached-type code when codex sets one', () => {
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 100, windowMinutes: 300 },
                weekly: { usedPercent: 100, windowMinutes: 10080 }
            },
            rateLimitReachedType: 'weekly'
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('blocked')
        expect(state?.effectiveReason).toContain('Weekly')
        expect(state?.metadata?.[0]).toEqual({ label: 'Limit Reached', value: 'Weekly' })
    })

    it('appends token breakdown metadata when reported', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 20_000, limitTokens: 100_000, percent: 20, updatedAt: 1 },
            rateLimits: {},
            totalTokenUsage: {
                inputTokens: 1000,
                cachedInputTokens: 500,
                outputTokens: 250,
                reasoningOutputTokens: 250,
                totalTokens: 2000
            }
        }
        const state = toCodexBudgetState(usage)
        const tokenRow = state?.metadata?.find((row) => row.label === 'Token Breakdown')
        expect(tokenRow?.value).toBe('2k')
        expect(tokenRow?.detail).toContain('input 1k')
    })

    it('does not flag blocked when credits.unlimited even with balance reading 0', () => {
        const usage: CodexUsage = {
            contextWindow: { usedTokens: 10_000, limitTokens: 100_000, percent: 10, updatedAt: 1 },
            rateLimits: {},
            credits: { hasCredits: true, unlimited: true, balance: '0' }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.effective).toBe('green')
        const creditsAxis = state?.axes.find((axis) => axis.id === 'credits')
        expect(creditsAxis?.valueText).toBe('Unlimited')
        expect(creditsAxis?.critical).toBeFalsy()
    })

    it('handles a fresh-session payload (token_count before context-window stats arrive)', () => {
        // Early in a session, codex sometimes emits rate_limits without a
        // contextWindow. The adapter must still produce a usable state
        // with an operational axis fallback.
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 12, windowMinutes: 300 }
            }
        }
        const state = toCodexBudgetState(usage)
        expect(state?.operationalAxisId).toBe('fiveHour')
        expect(state?.effective).toBe('green')
    })

    it('chooses an operational axis fallback when context is absent', () => {
        const usage: CodexUsage = {
            rateLimits: {
                fiveHour: { usedPercent: 30, windowMinutes: 300 },
                weekly: { usedPercent: 60, windowMinutes: 10080 }
            }
        }
        const state = toCodexBudgetState(usage)
        // No context -> pick the highest-pressure axis as operational so
        // the ring centre still shows the worst non-credits pressure.
        expect(state?.operationalAxisId).toBe('weekly')
    })
})

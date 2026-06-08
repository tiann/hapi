import type { CodexTokenUsage, CodexUsage, CodexUsageRateLimit } from '@hapi/protocol/types'

export type CodexUsageRow = {
    label: string
    value: string
    detail?: string
    severity?: 'critical' | 'warn'
}

// Subscription-and-credits exhausted: codex sends primary=null +
// secondary=null + credits.has_credits=false. The indicator should treat
// this as a "you are blocked, full red" state so users with a Pro
// subscription that ALSO topped up credits don't get a silent 80% ring.
export function isCodexUsageBlocked(usage: CodexUsage | null | undefined): boolean {
    if (!usage) return false
    if (usage.credits?.unlimited) return false
    const hasCreditsExplicitlyFalse = usage.credits?.hasCredits === false
    const balanceZero = usage.credits?.balance === '0' || usage.credits?.balance === '0.00'
    const noTimeWindows = !usage.rateLimits?.fiveHour && !usage.rateLimits?.weekly
    const reachedType = typeof usage.rateLimitReachedType === 'string' && usage.rateLimitReachedType.length > 0
    return reachedType || (noTimeWindows && (hasCreditsExplicitlyFalse || balanceZero))
}

function formatCreditsValue(credits: NonNullable<CodexUsage['credits']>): string {
    if (credits.unlimited) return 'Unlimited'
    if (credits.balance !== undefined) return `$${credits.balance}`
    if (credits.hasCredits === false) return 'Out'
    if (credits.hasCredits === true) return 'Available'
    return '-'
}

function formatRateLimitReachedType(value: string): string {
    return value
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, value))
}

function formatPercent(value: number): string {
    const clamped = clampPercent(value)
    return `${clamped >= 10 ? Math.round(clamped) : Math.round(clamped * 10) / 10}%`
}

function formatTokens(value: number): string {
    if (Math.abs(value) >= 1000) {
        return `${Math.round(value / 1000)}k`
    }
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
}

function formatRateLimit(rateLimit: CodexUsageRateLimit): string {
    return formatPercent(rateLimit.usedPercent)
}

export function formatCodexUsageReset(resetAt: number | undefined, locale?: string): string | null {
    if (!resetAt) {
        return null
    }
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(resetAt))
}

function formatTokenBreakdown(usage: CodexTokenUsage): string {
    return [
        `input ${formatTokens(usage.inputTokens)}`,
        `cached ${formatTokens(usage.cachedInputTokens)}`,
        `output ${formatTokens(usage.outputTokens)}`,
        `reasoning ${formatTokens(usage.reasoningOutputTokens)}`
    ].join(' · ')
}

export function getCodexUsageRingPercent(usage: CodexUsage | null | undefined): number | null {
    if (!usage) {
        return null
    }
    // Blocked accounts (subscription window AND credits both exhausted, or
    // explicit rate_limit_reached_type) must read 100% so the ring stops
    // misrepresenting the state as 'context window 80%, plenty of room'.
    if (isCodexUsageBlocked(usage)) {
        return 100
    }
    if (usage.contextWindow) {
        return clampPercent(usage.contextWindow.percent)
    }
    const candidates = [
        usage.rateLimits?.fiveHour?.usedPercent,
        usage.rateLimits?.weekly?.usedPercent
    ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (candidates.length === 0) {
        return null
    }
    return clampPercent(Math.max(...candidates))
}

export function getCodexUsageRows(usage: CodexUsage, locale?: string): CodexUsageRow[] {
    const rows: CodexUsageRow[] = []
    if (usage.rateLimitReachedType) {
        rows.push({
            label: 'Limit Reached',
            value: formatRateLimitReachedType(usage.rateLimitReachedType),
            severity: 'critical'
        })
    }
    if (usage.contextWindow) {
        rows.push({
            label: 'Context Window',
            value: formatPercent(usage.contextWindow.percent),
            detail: `${formatTokens(usage.contextWindow.usedTokens)} / ${formatTokens(usage.contextWindow.limitTokens)} tokens`
        })
    }
    if (usage.rateLimits?.fiveHour) {
        const reset = formatCodexUsageReset(usage.rateLimits.fiveHour.resetAt, locale)
        rows.push({
            label: '5h Usage',
            value: formatRateLimit(usage.rateLimits.fiveHour),
            detail: reset ? `resets ${reset}` : undefined
        })
    }
    if (usage.rateLimits?.weekly) {
        const reset = formatCodexUsageReset(usage.rateLimits.weekly.resetAt, locale)
        rows.push({
            label: '1 Week Usage',
            value: formatRateLimit(usage.rateLimits.weekly),
            detail: reset ? `resets ${reset}` : undefined
        })
    }
    // Surface credit-billing state when codex reports it - either an
    // unlimited flag, a hard balance, or an explicit has_credits=false.
    // Subscription-and-credits-exhausted accounts (Pro + top-up both at
    // zero) get a critical severity so the row is visually distinct
    // from a normal "5h Usage 50%" entry.
    if (usage.credits) {
        const balanceZero = usage.credits.balance === '0' || usage.credits.balance === '0.00'
        const exhausted = usage.credits.hasCredits === false || balanceZero
        const severity = !usage.credits.unlimited && exhausted ? 'critical' : undefined
        rows.push({
            label: 'Credits',
            value: formatCreditsValue(usage.credits),
            detail: usage.credits.unlimited
                ? 'unlimited'
                : exhausted
                    ? 'subscription / top-up exhausted'
                    : undefined,
            ...(severity ? { severity } : {})
        })
    }
    if (usage.totalTokenUsage) {
        rows.push({
            label: 'Token Breakdown',
            value: formatTokens(usage.totalTokenUsage.totalTokens),
            detail: formatTokenBreakdown(usage.totalTokenUsage)
        })
    }
    if (!usage.totalTokenUsage && usage.lastTokenUsage) {
        rows.push({
            label: 'Last Turn Tokens',
            value: formatTokens(usage.lastTokenUsage.totalTokens),
            detail: formatTokenBreakdown(usage.lastTokenUsage)
        })
    }
    return rows
}

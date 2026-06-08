import type { CodexTokenUsage, CodexUsage, CodexUsageRateLimit } from '@hapi/protocol/types'

export type CodexUsageRingAxis = 'blocked' | 'context' | 'fiveHour' | 'weekly'

export type CodexUsageRing = {
    percent: number
    axis: CodexUsageRingAxis
}

export type CodexUsageRow = {
    label: string
    value: string
    detail?: string
    severity?: 'critical' | 'warn'
    // True when this row corresponds to the dominant axis driving the
    // ring percent. Lets the popover visually link the ring meaning to
    // the row that produced it (e.g. 'weekly 100%' bolded when ring=100).
    dominant?: boolean
}

// Codex sends balance as a precision-preserving string ('250.0000000000',
// '0', '0.0000000000'). Number() handles all of those uniformly without
// risking a literal-match miss on a new trailing-zero variant.
function parseCreditsBalance(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
}

// Subscription-and-credits exhausted: codex sends primary=null +
// secondary=null + credits.has_credits=false. The indicator should treat
// this as a "you are blocked, full red" state so users with a Pro
// subscription that ALSO topped up credits don't get a silent 80% ring.
export function isCodexUsageBlocked(usage: CodexUsage | null | undefined): boolean {
    if (!usage) return false
    if (usage.credits?.unlimited) return false
    const hasCreditsExplicitlyFalse = usage.credits?.hasCredits === false
    const parsedBalance = parseCreditsBalance(usage.credits?.balance)
    const balanceZero = parsedBalance !== null && parsedBalance === 0
    const noTimeWindows = !usage.rateLimits?.fiveHour && !usage.rateLimits?.weekly
    const reachedType = typeof usage.rateLimitReachedType === 'string' && usage.rateLimitReachedType.length > 0
    return reachedType || (noTimeWindows && (hasCreditsExplicitlyFalse || balanceZero))
}

// Codex's protocol field is 'balance' with no declared unit. Credits
// are an internal billing token consumed at token-mix-dependent rates
// (per the OpenAI Codex rate card, GPT-5.5 burns 125 credits per 1M
// input tokens / 750 per 1M output, and a $5 top-up grants 125 credits
// ~ $0.04/credit). Render as a bare count; the row label 'Credits'
// carries the unit and any USD conversion belongs in chatgpt.com's
// billing UI, not the indicator. See
// https://help.openai.com/en/articles/20001106-codex-rate-card
function formatCreditsBalance(raw: string): string {
    const n = parseCreditsBalance(raw)
    if (n === null) return raw
    if (n === 0) return '0'
    const decimals = Math.abs(n) >= 1 ? 2 : 4
    return n.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals
    })
}

function formatCreditsValue(credits: NonNullable<CodexUsage['credits']>): string {
    if (credits.unlimited) return 'Unlimited'
    if (credits.balance !== undefined) return formatCreditsBalance(credits.balance)
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

// The ring shows the most-pressing constraint across every axis the user
// can plausibly run out of in the near term (context window, 5h rolling
// subscription window, weekly rolling subscription window, or full block).
// Original PR #537 preferred contextWindow over rate limits which produced
// the confusing state where weekly=100% but the ring showed context=80%,
// silently hiding a hard cap behind a softer one. Credits are intentionally
// NOT folded into the percent because codex's protocol doesn't expose a
// 'capacity' to convert balance -> percent against; instead the blocked
// state subsumes the 'credits=0 AND windows exhausted' case at 100%.
export function getCodexUsageRing(usage: CodexUsage | null | undefined): CodexUsageRing | null {
    if (!usage) return null
    if (isCodexUsageBlocked(usage)) {
        return { percent: 100, axis: 'blocked' }
    }
    const candidates: Array<{ percent: number; axis: CodexUsageRingAxis }> = []
    if (usage.contextWindow && Number.isFinite(usage.contextWindow.percent)) {
        candidates.push({ percent: clampPercent(usage.contextWindow.percent), axis: 'context' })
    }
    const fiveHour = usage.rateLimits?.fiveHour?.usedPercent
    if (typeof fiveHour === 'number' && Number.isFinite(fiveHour)) {
        candidates.push({ percent: clampPercent(fiveHour), axis: 'fiveHour' })
    }
    const weekly = usage.rateLimits?.weekly?.usedPercent
    if (typeof weekly === 'number' && Number.isFinite(weekly)) {
        candidates.push({ percent: clampPercent(weekly), axis: 'weekly' })
    }
    if (candidates.length === 0) return null
    // Ties broken by insertion order (context < fiveHour < weekly) - if
    // weekly and context both read 80, the more-painful-to-hit weekly
    // gets surfaced. reduce instead of sort to avoid an allocation on
    // every metadata patch.
    return candidates.reduce((best, candidate) =>
        candidate.percent > best.percent ? candidate : best,
    candidates[0])
}

// Kept for any future callers - returns just the percent without the
// dominant-axis context. ComposerButtons uses getCodexUsageRing directly.
export function getCodexUsageRingPercent(usage: CodexUsage | null | undefined): number | null {
    return getCodexUsageRing(usage)?.percent ?? null
}

const AXIS_TO_ROW_LABEL: Record<CodexUsageRingAxis, string | null> = {
    blocked: null,
    context: 'Context Window',
    fiveHour: '5h Usage',
    weekly: '1 Week Usage'
}

export function getCodexUsageRingTitle(ring: CodexUsageRing, usage: CodexUsage): string {
    const pct = `${Math.round(ring.percent)}%`
    switch (ring.axis) {
        case 'blocked':
            return usage.rateLimitReachedType
                ? `Blocked: ${formatRateLimitReachedType(usage.rateLimitReachedType)} limit reached`
                : 'Blocked: subscription window and credits both exhausted'
        case 'context':
            return `Context window ${pct} full`
        case 'fiveHour':
            return `5h subscription window ${pct} used`
        case 'weekly':
            return `Weekly subscription window ${pct} used`
    }
}

export function getCodexUsageRows(usage: CodexUsage, locale?: string): CodexUsageRow[] {
    const rows: CodexUsageRow[] = []
    const ring = getCodexUsageRing(usage)
    const dominantLabel = ring ? AXIS_TO_ROW_LABEL[ring.axis] : null
    const markDominant = (row: CodexUsageRow): CodexUsageRow =>
        row.label === dominantLabel ? { ...row, dominant: true } : row
    if (usage.rateLimitReachedType) {
        rows.push({
            label: 'Limit Reached',
            value: formatRateLimitReachedType(usage.rateLimitReachedType),
            severity: 'critical'
        })
    }
    if (usage.contextWindow) {
        rows.push(markDominant({
            label: 'Context Window',
            value: formatPercent(usage.contextWindow.percent),
            detail: `${formatTokens(usage.contextWindow.usedTokens)} / ${formatTokens(usage.contextWindow.limitTokens)} tokens`
        }))
    }
    if (usage.rateLimits?.fiveHour) {
        const reset = formatCodexUsageReset(usage.rateLimits.fiveHour.resetAt, locale)
        rows.push(markDominant({
            label: '5h Usage',
            value: formatRateLimit(usage.rateLimits.fiveHour),
            detail: reset ? `resets ${reset}` : undefined
        }))
    }
    if (usage.rateLimits?.weekly) {
        const reset = formatCodexUsageReset(usage.rateLimits.weekly.resetAt, locale)
        rows.push(markDominant({
            label: '1 Week Usage',
            value: formatRateLimit(usage.rateLimits.weekly),
            detail: reset ? `resets ${reset}` : undefined
        }))
    }
    // Surface credit-billing state when codex reports it - either an
    // unlimited flag, a hard balance, or an explicit has_credits=false.
    // Subscription-and-credits-exhausted accounts (Pro + top-up both at
    // zero) get a critical severity so the row is visually distinct
    // from a normal "5h Usage 50%" entry.
    if (usage.credits) {
        const parsedBalance = parseCreditsBalance(usage.credits.balance)
        const balanceZero = parsedBalance !== null && parsedBalance === 0
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

import type {
    AgentBudgetAxis,
    AgentBudgetEffectiveState,
    AgentBudgetMetadataRow,
    AgentBudgetState,
    CodexTokenUsage,
    CodexUsage,
    CodexUsageRateLimit
} from '@hapi/protocol/types'

// Codex-specific adapter that maps a CodexUsage payload into the
// flavor-agnostic AgentBudgetState the indicator consumes. All
// Codex-specific terminology (5h / weekly / credits / plan_type / etc)
// lives here, not in the renderer.

// Codex sends balance as a precision-preserving string ('250.0000000000',
// '0', '0.0000000000'). Number() handles all of those uniformly without
// risking a literal-match miss on a new trailing-zero variant.
export function parseCreditsBalance(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
}

// Subscription-and-credits exhausted. Codex has two payload shapes here:
//   (a) post-exhaustion: rate_limits.primary=null + secondary=null +
//       credits.has_credits=false (steady state once windows have fully
//       fallen back to credit billing).
//   (b) transition: both rate_limits.primary and .secondary present with
//       usedPercent=100 alongside credits.has_credits=false. Brief window
//       before codex nulls the rate limits out, but the user IS blocked
//       during it.
// Either shape, or an explicit rate_limit_reached_type, should land in
// the 'blocked' effective state so the indicator surfaces the hard cap
// with consistent messaging instead of a less-specific 'red 100%'.
export function isCodexUsageBlocked(usage: CodexUsage | null | undefined): boolean {
    if (!usage) return false
    if (usage.credits?.unlimited) return false
    const reachedType = typeof usage.rateLimitReachedType === 'string' && usage.rateLimitReachedType.length > 0
    if (reachedType) return true

    const hasCreditsExplicitlyFalse = usage.credits?.hasCredits === false
    const parsedBalance = parseCreditsBalance(usage.credits?.balance)
    const balanceZero = parsedBalance !== null && parsedBalance === 0
    const creditsExhausted = hasCreditsExplicitlyFalse || balanceZero

    const fiveHour = usage.rateLimits?.fiveHour
    const weekly = usage.rateLimits?.weekly
    const noTimeWindows = !fiveHour && !weekly
    // Shape (b): both windows present but at the cap. Either-or doesn't
    // trigger blocked - one window might cap while the other has room
    // (e.g. 5h hit during weekly's reset period).
    const bothWindowsCapped = (fiveHour?.usedPercent ?? 0) >= 100 && (weekly?.usedPercent ?? 0) >= 100
    return creditsExhausted && (noTimeWindows || bothWindowsCapped)
}

export function formatRateLimitReachedType(value: string): string {
    return value
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export function formatCodexUsageReset(resetAt: number | undefined, locale?: string): string | null {
    if (!resetAt || resetAt <= 0) return null
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(new Date(resetAt))
}

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
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

function formatTokenBreakdown(usage: CodexTokenUsage): string {
    return [
        `input ${formatTokens(usage.inputTokens)}`,
        `cached ${formatTokens(usage.cachedInputTokens)}`,
        `output ${formatTokens(usage.outputTokens)}`,
        `reasoning ${formatTokens(usage.reasoningOutputTokens)}`
    ].join(' · ')
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

// Codex-specific effective-state logic. Honours the Pro-tier billing
// rule that exhausted subscription windows fall back to credit-billing,
// so weekly=100% with credits>0 is amber (covering scenario) rather than
// red (genuinely about to fail).
function deriveEffectiveState(
    usage: CodexUsage,
    axes: AgentBudgetAxis[]
): { effective: AgentBudgetEffectiveState; reason: string } {
    if (isCodexUsageBlocked(usage)) {
        const reason = usage.rateLimitReachedType
            ? `Blocked: ${formatRateLimitReachedType(usage.rateLimitReachedType)} limit reached`
            : 'Blocked: subscription window and credits both exhausted'
        return { effective: 'blocked', reason }
    }

    const subscriptionCapped = axes.some(
        (axis) => (axis.id === 'fiveHour' || axis.id === 'weekly') && axis.pressure >= 100
    )
    const creditsCovering = axes.some((axis) => axis.id === 'credits' && axis.covering === true)
    if (subscriptionCapped && creditsCovering) {
        const cappedAxis = axes.find(
            (axis) => (axis.id === 'fiveHour' || axis.id === 'weekly') && axis.pressure >= 100
        )
        const label = cappedAxis?.label ?? 'Subscription window'
        return {
            effective: 'amber',
            reason: `${label} at cap; credits covering overage`
        }
    }

    // Credits axis pressure==0 means 'available and not covering' - it
    // should not push the gauge into amber/red by itself.
    const pressureCandidates = axes.filter((axis) => axis.id !== 'credits' || axis.pressure > 0)
    const maxPressure = pressureCandidates.length > 0
        ? Math.max(...pressureCandidates.map((axis) => axis.pressure))
        : 0
    if (maxPressure >= 95) {
        const dominantAxis = pressureCandidates.find((axis) => axis.pressure === maxPressure)
        return {
            effective: 'red',
            reason: dominantAxis ? `${dominantAxis.label} ${Math.round(maxPressure)}%` : 'Near cap'
        }
    }
    if (maxPressure >= 60) {
        const dominantAxis = pressureCandidates.find((axis) => axis.pressure === maxPressure)
        return {
            effective: 'amber',
            reason: dominantAxis ? `${dominantAxis.label} ${Math.round(maxPressure)}%` : 'Approaching cap'
        }
    }
    return { effective: 'green', reason: 'All budgets well below caps' }
}

export function toCodexBudgetState(usage: CodexUsage | null | undefined): AgentBudgetState | null {
    if (!usage) return null

    const axes: AgentBudgetAxis[] = []

    if (usage.contextWindow && Number.isFinite(usage.contextWindow.percent)) {
        axes.push({
            id: 'context',
            label: 'Context Window',
            pressure: clampPercent(usage.contextWindow.percent),
            valueText: formatPercent(usage.contextWindow.percent),
            detail: `${formatTokens(usage.contextWindow.usedTokens)} / ${formatTokens(usage.contextWindow.limitTokens)} tokens`
        })
    }
    if (usage.rateLimits?.fiveHour) {
        const reset = formatCodexUsageReset(usage.rateLimits.fiveHour.resetAt)
        axes.push({
            id: 'fiveHour',
            label: '5h Usage',
            pressure: clampPercent(usage.rateLimits.fiveHour.usedPercent),
            valueText: formatRateLimit(usage.rateLimits.fiveHour),
            ...(reset ? { detail: `resets ${reset}` } : {})
        })
    }
    if (usage.rateLimits?.weekly) {
        const reset = formatCodexUsageReset(usage.rateLimits.weekly.resetAt)
        axes.push({
            id: 'weekly',
            label: '1 Week Usage',
            pressure: clampPercent(usage.rateLimits.weekly.usedPercent),
            valueText: formatRateLimit(usage.rateLimits.weekly),
            ...(reset ? { detail: `resets ${reset}` } : {})
        })
    }
    if (usage.credits) {
        const parsedBalance = parseCreditsBalance(usage.credits.balance)
        const balanceZero = parsedBalance !== null && parsedBalance === 0
        const exhausted = !usage.credits.unlimited && (usage.credits.hasCredits === false || balanceZero)
        const subscriptionExists = axes.some((axis) => axis.id === 'fiveHour' || axis.id === 'weekly')
        const subscriptionCapped = axes.some(
            (axis) => (axis.id === 'fiveHour' || axis.id === 'weekly') && axis.pressure >= 100
        )
        // Credits axis pressure: codex's protocol doesn't expose a
        // 'capacity' to derive a true percent against, so the adapter
        // picks a pragmatic mapping. When exhausted -> 100 so the row
        // participates in dominant-axis selection (rendered critical).
        // When credits remain, axis is 'covering' iff at least one
        // subscription window is already at cap - that signals 'this
        // axis is keeping you going' rather than 'this axis is a
        // constraint'.
        const pressure = exhausted ? 100 : 0
        const covering = !exhausted && subscriptionExists && subscriptionCapped
        axes.push({
            id: 'credits',
            label: 'Credits',
            pressure,
            valueText: formatCreditsValue(usage.credits),
            ...(usage.credits.unlimited
                ? { detail: 'unlimited' }
                : exhausted
                    ? { detail: 'subscription / top-up exhausted', critical: true }
                    : covering
                        ? { detail: 'covering exhausted subscription window', covering: true }
                        : {})
        })
    }

    if (axes.length === 0) return null

    const metadata: AgentBudgetMetadataRow[] = []
    if (usage.rateLimitReachedType) {
        metadata.push({
            label: 'Limit Reached',
            value: formatRateLimitReachedType(usage.rateLimitReachedType)
        })
    }
    if (usage.totalTokenUsage) {
        metadata.push({
            label: 'Token Breakdown',
            value: formatTokens(usage.totalTokenUsage.totalTokens),
            detail: formatTokenBreakdown(usage.totalTokenUsage)
        })
    } else if (usage.lastTokenUsage) {
        metadata.push({
            label: 'Last Turn Tokens',
            value: formatTokens(usage.lastTokenUsage.totalTokens),
            detail: formatTokenBreakdown(usage.lastTokenUsage)
        })
    }

    const { effective, reason } = deriveEffectiveState(usage, axes)

    const operationalAxisId = axes.find((axis) => axis.id === 'context')
        ? 'context'
        : axes.reduce((best, axis) => (axis.pressure > best.pressure ? axis : best), axes[0]).id

    const dominantCandidates = axes.filter((axis) => !(axis.id === 'credits' && axis.pressure === 0))
    const dominant = dominantCandidates.length > 0
        ? dominantCandidates.reduce((best, axis) => (axis.pressure > best.pressure ? axis : best), dominantCandidates[0])
        : undefined

    return {
        operationalAxisId,
        axes,
        ...(metadata.length > 0 ? { metadata } : {}),
        effective,
        effectiveReason: reason,
        ...(dominant ? { dominantAxisId: dominant.id } : {})
    }
}

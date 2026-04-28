import type { CodexTokenUsage, CodexUsage, CodexUsageRateLimit } from '@hapi/protocol/types'

export type CodexUsageRow = {
    label: string
    value: string
    detail?: string
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

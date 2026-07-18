import type { AgentEvent } from '@/chat/types'

function normalizeTimestamp(value: number): Date {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(ms)
}

export function formatUnixTimestamp(value: number): string {
    const date = normalizeTimestamp(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
}

export function formatResetTime(value: number): string {
    const date = normalizeTimestamp(value)
    if (Number.isNaN(date.getTime())) return String(value)

    const now = new Date()
    const isToday = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()

    if (isToday) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Known types: five_hour → "5-hour", seven_day → "7-day".
// Unknown types use underscore-to-space fallback (e.g. thirty_day → "thirty day").
function formatLimitType(limitType: string | undefined): string {
    if (!limitType) return ''
    if (limitType === 'five_hour') return '5-hour'
    if (limitType === 'seven_day') return '7-day'
    return limitType.replace(/_/g, ' ')
}

function formatDuration(ms: number): string {
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${mins}m ${secs}s`
}

function formatTokenCount(value: number): string {
    const rounded = Math.round(value)
    const abs = Math.abs(rounded)
    if (abs >= 1_000_000) return `${Math.round(rounded / 1_000_000)}M`
    if (abs >= 1_000) return `${Math.round(rounded / 1_000)}K`
    return String(rounded)
}

export type EventPresentation = {
    icon: string | null
    text: string
}

export function getEventPresentation(event: AgentEvent): EventPresentation {
    if (event.type === 'api-error') {
        const { retryAttempt, maxRetries } = event as { retryAttempt: number; maxRetries: number }
        if (maxRetries > 0 && retryAttempt >= maxRetries) {
            return { icon: '⚠️', text: 'API error: Max retries reached' }
        }
        if (maxRetries > 0) {
            return { icon: '⏳', text: `API error: Retrying (${retryAttempt}/${maxRetries})` }
        }
        if (retryAttempt > 0) {
            return { icon: '⏳', text: 'API error: Retrying...' }
        }
        return { icon: '⚠️', text: 'API error' }
    }
    if (event.type === 'switch') {
        const mode = event.mode === 'local' ? 'local' : 'remote'
        return { icon: '🔄', text: `Switched to ${mode}` }
    }
    if (event.type === 'title-changed') {
        const title = typeof event.title === 'string' ? event.title : ''
        return { icon: null, text: title ? `Title changed to "${title}"` : 'Title changed' }
    }
    if (event.type === 'permission-mode-changed') {
        const modeValue = (event as Record<string, unknown>).mode
        const mode = typeof modeValue === 'string' ? modeValue : 'default'
        return { icon: '🔐', text: `Permission mode: ${mode}` }
    }
    if (event.type === 'limit-warning') {
        const ev = event as { utilization?: number; endsAt?: number; limitType?: string }
        const pct = Math.round((ev.utilization ?? 0) * 100)
        const endsAt = typeof ev.endsAt === 'number' ? ev.endsAt : null
        const typeLabel = formatLimitType(ev.limitType)
        const suffix = typeLabel ? ` (${typeLabel})` : ''
        return { icon: '⚠️', text: endsAt ? `Usage limit ${pct}%${suffix} · resets ${formatResetTime(endsAt)}` : `Usage limit ${pct}%${suffix}` }
    }
    if (event.type === 'limit-reached') {
        const ev = event as { endsAt?: number; limitType?: string }
        const endsAt = typeof ev.endsAt === 'number' ? ev.endsAt : null
        const typeLabel = formatLimitType(ev.limitType)
        const suffix = typeLabel ? ` (${typeLabel})` : ''
        return { icon: '⏳', text: endsAt ? `Usage limit reached${suffix} until ${formatUnixTimestamp(endsAt)}` : `Usage limit reached${suffix}` }
    }
    if (event.type === 'message') {
        return { icon: null, text: typeof event.message === 'string' ? event.message : 'Message' }
    }
    if (event.type === 'background-notification') {
        return { icon: null, text: typeof event.message === 'string' ? event.message : 'Background notification' }
    }
    if (event.type === 'turn-duration') {
        const ms = typeof event.durationMs === 'number' ? event.durationMs : 0
        return { icon: '⏱️', text: `Turn: ${formatDuration(ms)}` }
    }
    if (event.type === 'microcompact') {
        const saved = typeof event.tokensSaved === 'number' ? event.tokensSaved : 0
        const formatted = formatTokenCount(saved)
        return { icon: '📦', text: `Context compacted (saved ${formatted} tokens)` }
    }
    if (event.type === 'compact') {
        const ev = event as { preTokens?: unknown; postTokens?: unknown; tokensSaved?: unknown }
        const preTokens = typeof ev.preTokens === 'number' && Number.isFinite(ev.preTokens) && ev.preTokens > 0
            ? ev.preTokens
            : null
        const postTokens = typeof ev.postTokens === 'number' && Number.isFinite(ev.postTokens) && ev.postTokens > 0
            ? ev.postTokens
            : null
        const explicitSaved = typeof ev.tokensSaved === 'number' && Number.isFinite(ev.tokensSaved) && ev.tokensSaved > 0
            ? ev.tokensSaved
            : null
        const tokensSaved = explicitSaved ?? (preTokens !== null && postTokens !== null && preTokens > postTokens ? preTokens - postTokens : null)
        if (preTokens !== null && postTokens !== null && tokensSaved !== null) {
            return {
                icon: '📦',
                text: `Conversation compacted (${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)}, saved ${formatTokenCount(tokensSaved)} tokens)`
            }
        }
        if (tokensSaved !== null) {
            return { icon: '📦', text: `Conversation compacted (saved ${formatTokenCount(tokensSaved)} tokens)` }
        }
        return { icon: '📦', text: 'Conversation compacted' }
    }
    if (event.type === 'moa-aggregating') {
        const aggregator = (event as Record<string, unknown>).aggregator
        return {
            icon: '🧩',
            text: typeof aggregator === 'string' && aggregator.trim()
                ? `MoA aggregating with ${aggregator.trim()}`
                : 'MoA aggregating'
        }
    }
    try {
        return { icon: null, text: JSON.stringify(event) }
    } catch {
        return { icon: null, text: String(event.type) }
    }
}

export function renderEventLabel(event: AgentEvent): string {
    return getEventPresentation(event).text
}

import type { AgentEvent } from '@/chat/types'

export function formatUnixTimestamp(value: number): string {
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
}

export function renderEventLabel(event: AgentEvent): string {
    if (event.type === 'switch') {
        const mode = event.mode === 'local' ? 'local' : 'remote'
        return `🔄 Switched to ${mode}`
    }
    if (event.type === 'title-changed') {
        const title = typeof event.title === 'string' ? event.title : ''
        return title ? `Title changed to "${title}"` : 'Title changed'
    }
    if (event.type === 'permission-mode-changed') {
        const modeValue = (event as Record<string, unknown>).mode
        const mode = typeof modeValue === 'string' ? modeValue : 'default'
        return `🔐 Permission mode: ${mode}`
    }
    if (event.type === 'limit-reached') {
        const endsAt = typeof event.endsAt === 'number' ? event.endsAt : null
        return endsAt ? `⏳ Usage limit reached until ${formatUnixTimestamp(endsAt)}` : '⏳ Usage limit reached'
    }
    if (event.type === 'message') {
        return typeof event.message === 'string' ? event.message : 'Message'
    }
    try {
        return JSON.stringify(event)
    } catch {
        return String(event.type)
    }
}


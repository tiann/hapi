import { randomUUID } from 'node:crypto'
import type { ApiSessionClient } from '@/api/apiSession'

const MAX_FALLBACK_TITLE_LENGTH = 80

export function createSessionTitleFallback(message: string): string | null {
    const normalized = message.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    if (normalized.length <= MAX_FALLBACK_TITLE_LENGTH) return normalized

    return normalized.slice(0, MAX_FALLBACK_TITLE_LENGTH - 1).trimEnd() + '…'
}

export function applySessionTitleFallback(
    client: Pick<ApiSessionClient, 'hasSessionTitle' | 'sendClaudeSessionMessage'>,
    message: string
): boolean {
    if (client.hasSessionTitle()) return false

    const title = createSessionTitleFallback(message)
    if (!title) return false

    client.sendClaudeSessionMessage({
        type: 'summary',
        summary: title,
        leafUuid: randomUUID()
    })
    return true
}

import type { ApiSessionClient } from '@/api/apiSession'
import { applySessionTitleSummary, type SessionTitleSummaryOptions } from '@/agent/sessionTitlePolicy'

const MAX_FALLBACK_TITLE_LENGTH = 80

export function createSessionTitleFallback(message: string): string | null {
    const normalized = message.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    if (normalized.length <= MAX_FALLBACK_TITLE_LENGTH) return normalized

    return normalized.slice(0, MAX_FALLBACK_TITLE_LENGTH - 1).trimEnd() + '…'
}

export function applySessionTitleFallback(
    client: Pick<ApiSessionClient, 'updateMetadata'>,
    message: string,
    options: SessionTitleSummaryOptions = {}
): boolean {
    const title = createSessionTitleFallback(message)
    if (!title) return false

    return applySessionTitleSummary(client, title, options)
}

import type { ApiSessionClient } from '@/api/apiSession'

const MAX_FALLBACK_TITLE_LENGTH = 80

export function createSessionTitleFallback(message: string): string | null {
    const normalized = message.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    if (normalized.length <= MAX_FALLBACK_TITLE_LENGTH) return normalized

    return normalized.slice(0, MAX_FALLBACK_TITLE_LENGTH - 1).trimEnd() + '…'
}

export function applySessionTitleFallback(
    client: Pick<ApiSessionClient, 'updateMetadata'>,
    message: string
): boolean {
    const title = createSessionTitleFallback(message)
    if (!title) return false

    client.updateMetadata((metadata) => {
        if (metadata.name?.trim() || metadata.summary?.text.trim()) return metadata

        return {
            ...metadata,
            summary: {
                text: title,
                updatedAt: Date.now()
            }
        }
    })
    return true
}

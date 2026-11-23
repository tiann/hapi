export type MessageSearchTarget = {
    messageId?: string
    messageQuery?: string
}

/** Search-result deep links are valid only when both target fields are present. */
export function normalizeMessageSearchTarget(
    messageId: unknown,
    messageQuery: unknown
): MessageSearchTarget {
    const normalizedMessageId = typeof messageId === 'string' ? messageId.trim() : ''
    const normalizedMessageQuery = typeof messageQuery === 'string' ? messageQuery.trim() : ''
    if (!normalizedMessageId || !normalizedMessageQuery) return {}

    return {
        messageId: normalizedMessageId,
        messageQuery: normalizedMessageQuery,
    }
}

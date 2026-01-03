import type { NormalizedMessage } from '@/chat/types'
import { isObject } from '@/chat/normalizeUtils'

export function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown
): NormalizedMessage | null {
    if (typeof content === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: false,
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text },
            isSidechain: false,
            meta
        }
    }

    return null
}

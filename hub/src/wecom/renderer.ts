import type { Session } from '../sync/syncEngine'

export const ACTION_APPROVE = 'ap'
export const ACTION_DENY = 'dn'

/**
 * Encode a callback button payload as `action:sessionId[:requestId]`.
 *
 * WeCom's button `key` field tolerates up to 1024 bytes (per the official
 * SDK type), so unlike the Telegram channel we don't need to truncate the
 * IDs. Carrying the full session and request IDs lets us resolve clicks via
 * exact match in {@link findSessionById}, eliminating the prefix-collision
 * window where two sessions or pending requests in the same namespace
 * could share an 8-char prefix and a click could approve the wrong one.
 *
 * Assumes neither {@link sessionId} nor {@link requestId} contains a `:`
 * (true for randomUUID-shaped IDs, which is what the hub uses today).
 */
export function createCallbackData(action: string, sessionId: string, requestId?: string): string {
    return requestId ? `${action}:${sessionId}:${requestId}` : `${action}:${sessionId}`
}

export function parseCallbackData(data: string): {
    action: string
    sessionId: string
    requestId?: string
} {
    const parts = data.split(':')
    return {
        action: parts[0] ?? '',
        sessionId: parts[1] ?? '',
        requestId: parts.length > 2 ? parts.slice(2).join(':') : undefined
    }
}

export function findSessionById(sessions: Session[], id: string): Session | undefined {
    if (!id) return undefined
    return sessions.find((session) => session.id === id)
}

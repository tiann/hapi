/**
 * Utilities for Telegram Bot
 *
 * Helper functions for rendering and callback data handling.
 * Simplified to only include utilities needed for notifications.
 */

import type { Session } from '../sync/syncEngine'

// Telegram limits
const MAX_MESSAGE_LENGTH = 4096
const MAX_CALLBACK_DATA = 64

/**
 * Truncate text to fit within a limit
 */
export function truncate(text: string, maxLen: number = MAX_MESSAGE_LENGTH - 100): string {
    if (text.length <= maxLen) return text
    return text.slice(0, maxLen - 3) + '...'
}

/**
 * Get session name (project name or directory name)
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/')
        return parts[parts.length - 1] || session.metadata.path
    }
    return 'Unknown'
}

/**
 * Create callback data with size limit
 * Format: action:sessionIdPrefix:extraData
 */
export function createCallbackData(action: string, sessionId: string, extra?: string): string {
    // Use 8-char prefix for session ID to save space
    const sessionPrefix = sessionId.slice(0, 8)
    let data = `${action}:${sessionPrefix}`

    if (extra) {
        // Ensure we don't exceed 64 bytes
        const remaining = MAX_CALLBACK_DATA - data.length - 1
        if (remaining > 0) {
            data += `:${extra.slice(0, remaining)}`
        }
    }

    return data.slice(0, MAX_CALLBACK_DATA)
}

/**
 * Parse callback data
 */
export function parseCallbackData(data: string): { action: string; sessionPrefix: string; extra?: string } {
    const parts = data.split(':')
    return {
        action: parts[0] || '',
        sessionPrefix: parts[1] || '',
        extra: parts[2]
    }
}

/**
 * Find session by ID prefix
 */
export function findSessionByPrefix(sessions: Session[], prefix: string): Session | undefined {
    return sessions.find(s => s.id.startsWith(prefix))
}

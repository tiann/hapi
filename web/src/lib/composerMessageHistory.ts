import type { NormalizedMessage } from '@/chat/types'
import type { AttachmentMetadata } from '@/types/api'

export const COMPOSER_HISTORY_PREFIXES = ['#', '＃'] as const

export type ComposerMessageHistoryEntry = {
    id: string
    text: string
    attachments: readonly AttachmentMetadata[]
    createdAt: number
}

export type ComposerHistoryTrigger = {
    prefix: (typeof COMPOSER_HISTORY_PREFIXES)[number]
    query: string
}

/**
 * Detects the history trigger independently from the general autocomplete
 * word detector. History is intentionally available only from the first
 * character of the whole composer and only while the query is on its first
 * line.
 */
export function getComposerHistoryTrigger(
    text: string,
    selection: { start: number; end: number },
): ComposerHistoryTrigger | null {
    if (selection.start !== selection.end || selection.start < 1 || selection.start > text.length) {
        return null
    }

    const prefix = text.charAt(0)
    if (!COMPOSER_HISTORY_PREFIXES.includes(prefix as (typeof COMPOSER_HISTORY_PREFIXES)[number])) {
        return null
    }

    const query = text.slice(1, selection.start)
    // A space immediately after the prefix means the user is typing literal
    // text, not searching history. Keep the candidate list dismissed until
    // the prefix is deleted or a non-whitespace query is entered.
    if (query.includes('\n') || /^\s/.test(query)) return null

    return {
        prefix: prefix as (typeof COMPOSER_HISTORY_PREFIXES)[number],
        query,
    }
}

/**
 * Builds the local history inventory from the normalized, currently loaded
 * message window. Newest messages appear first. Sidechain/system-generated
 * user-shaped content is excluded, as are attachment-only messages because
 * history restores text rather than files.
 */
export function buildComposerMessageHistory(
    messages: readonly NormalizedMessage[],
): ComposerMessageHistoryEntry[] {
    const entries: ComposerMessageHistoryEntry[] = []
    const seen = new Set<string>()

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (
            !message
            || message.role !== 'user'
            || message.isSidechain
            || message.status === 'failed'
            || seen.has(message.id)
        ) continue

        const text = message.content.text
        if (text.trim().length === 0) continue

        seen.add(message.id)
        entries.push({
            id: message.id,
            text,
            attachments: message.content.attachments ?? [],
            createdAt: message.createdAt,
        })
    }

    return entries
}

export function filterComposerMessageHistory(
    entries: readonly ComposerMessageHistoryEntry[],
    query: string,
): ComposerMessageHistoryEntry[] {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (normalizedQuery.length === 0) return [...entries]

    return entries.filter((entry) => entry.text.toLocaleLowerCase().includes(normalizedQuery))
}

export function formatComposerHistoryPreview(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export type CodexImportedMessageSource = 'event_msg' | 'response_item'

export type CodexImportedMessageContent = {
    role: 'user'
    content: {
        type: 'text'
        text: string
    }
    meta: {
        sentFrom: 'cli'
    }
} | {
    role: 'agent'
    content: {
        type: typeof AGENT_MESSAGE_PAYLOAD_TYPE
        data: unknown
    }
    meta: {
        sentFrom: 'cli'
    }
}

export type CodexImportedMessageEntry = {
    source: CodexImportedMessageSource
    message: CodexImportedMessageContent
}

/**
 * Codex injects its own context as a synthetic user turn inside a
 * `response_item`. Those turns are not something the operator typed, so they
 * must not show up as chat messages.
 *
 * Only a `response_item` is filtered: an `event_msg` user message is always a
 * real operator turn, even when it happens to start with the same marker.
 */
export function shouldIgnoreInjectedResponseUserMessage(text: string): boolean {
    const normalized = text.trim()
    const lower = normalized.toLowerCase()
    const isAgentInstructions = lower.startsWith('# agents.md instructions')
    const isEnvironmentContext = lower.startsWith('<environment_context>')
        && lower.endsWith('</environment_context>')
    return isAgentInstructions || isEnvironmentContext
}

function stableSerialize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function normalizeComparableUserMessage(content: unknown): string | null {
    const record = asRecord(content)
    if (!record || record.role !== 'user') return null

    const body = asRecord(record.content)
    if (body?.type !== 'text' || typeof body.text !== 'string') return null

    return stableSerialize({
        role: 'user',
        text: body.text.trimEnd()
    })
}

function normalizeComparableAgentMessage(content: unknown): string | null {
    const record = asRecord(content)
    if (!record || record.role !== 'agent') return null

    const body = asRecord(record.content)
    if (!body || body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null

    const data = asRecord(body.data)
    if (data?.type !== 'message' || typeof data.message !== 'string') return null

    return stableSerialize({
        role: 'agent',
        type: 'message',
        message: data.message
    })
}

function normalizeAdjacentDuplicateMessage(content: unknown): string | null {
    return normalizeComparableUserMessage(content) ?? normalizeComparableAgentMessage(content)
}

function isAdjacentDuplicateImportedMessage(
    previous: CodexImportedMessageContent,
    next: CodexImportedMessageContent
): boolean {
    const previousKey = normalizeAdjacentDuplicateMessage(previous)
    const nextKey = normalizeAdjacentDuplicateMessage(next)
    return previousKey !== null && previousKey === nextKey
}

function isMirroredAdjacentDuplicate(
    previous: CodexImportedMessageEntry | undefined,
    next: CodexImportedMessageEntry
): boolean {
    return Boolean(
        previous
        && previous.source !== next.source
        && isAdjacentDuplicateImportedMessage(previous.message, next.message)
    )
}

function isResponseItemDuplicateOfEventUserMessage(
    entry: CodexImportedMessageEntry,
    recentEventUserMessageKey: string | null
): boolean {
    if (entry.source !== 'response_item' || recentEventUserMessageKey === null) return false

    return normalizeComparableUserMessage(entry.message) === recentEventUserMessageKey
}

/**
 * Collapse the mirrored copies Codex writes into its transcripts.
 *
 * A single operator turn is recorded twice: once as an `event_msg` and once as
 * a `response_item`. Only that mirrored pair may be folded - two identical
 * messages that come from the same source are two real turns and are kept.
 */
export function deduplicateCodexTranscriptMessages(entries: CodexImportedMessageEntry[]): CodexImportedMessageContent[] {
    const deduped: CodexImportedMessageEntry[] = []
    let recentEventUserMessageKey: string | null = null

    for (const entry of entries) {
        const userMessageKey = normalizeComparableUserMessage(entry.message)
        if (entry.source === 'event_msg' && userMessageKey !== null) {
            const previous = deduped[deduped.length - 1]
            if (previous?.source === 'response_item' && isMirroredAdjacentDuplicate(previous, entry)) {
                deduped[deduped.length - 1] = entry
            } else {
                deduped.push(entry)
            }
            recentEventUserMessageKey = userMessageKey
            continue
        }
        if (isResponseItemDuplicateOfEventUserMessage(entry, recentEventUserMessageKey)) continue
        const previous = deduped[deduped.length - 1]
        if (isMirroredAdjacentDuplicate(previous, entry)) {
            recentEventUserMessageKey = null
            continue
        }
        deduped.push(entry)
        recentEventUserMessageKey = null
    }

    return deduped.map((entry) => entry.message)
}

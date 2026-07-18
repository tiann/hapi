import {
    CODEX_DESKTOP_SYNC_LOCAL_ID_PREFIX,
    CODEX_DESKTOP_SYNC_SOURCE,
    isObject,
    isNonblankAgentOutputUserTurnStart,
    unwrapRoleWrappedRecordEnvelope,
} from '@hapi/protocol'
import type { DecryptedMessage } from '@hapi/protocol/types'
import type { StoredMessage } from '../store'

export const MESSAGE_PAGE_SCAN_CHUNK_SIZE = 200
export const MESSAGE_PAGE_SCAN_BUDGET = 10_000

export type MessagePageDirection = 'latest' | 'older' | 'newer'

export type MessagePageOptions = {
    limit: number
    beforeSeq: number | null
    afterSeq: number | null
}

export type MessagePageContinuation = {
    direction: 'older' | 'newer'
    cursorSeq: number
}

export type MessagePageResult = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        direction: MessagePageDirection
        beforeSeq: number | null
        afterSeq: number | null
        nextBeforeSeq: number | null
        nextAfterSeq: number | null
        hasMore: boolean
        hasOlder: boolean
        hasNewer: boolean
        range: { startSeq: number; endSeq: number } | null
        startComplete: boolean
        endComplete: boolean
        continuation: MessagePageContinuation | null
    }
}

export type MessagePageStore = {
    getMessages(
        sessionId: string,
        limit: number,
        beforeSeq?: number,
        options?: { maxLimit?: number },
    ): StoredMessage[]
    getMessagesAfter(
        sessionId: string,
        afterSeq: number,
        limit: number,
        options?: { maxLimit?: number },
    ): StoredMessage[]
}

const CODEX_SYNC_PSEUDO_USER_PREFIXES = [
    '<subagent_notification>',
    '<turn_aborted>',
]

export function extractTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }
    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return content.text
    }
    return null
}

export { extractAgentOutputUserText } from '@hapi/protocol'

export function isSkippableCodexPseudoUserMessage(
    message: StoredMessage,
    text: string,
    meta?: unknown,
): boolean {
    const isCodexSyncArtifact = (
        typeof message.localId === 'string'
        && message.localId.startsWith(CODEX_DESKTOP_SYNC_LOCAL_ID_PREFIX)
    ) || (isObject(meta) && meta.sentFrom === CODEX_DESKTOP_SYNC_SOURCE)
    if (!isCodexSyncArtifact) {
        return false
    }
    const trimmed = text.trimStart()
    return CODEX_SYNC_PSEUDO_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function isLogicalTurnStart(message: StoredMessage): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return false
    }

    if (record.role === 'user') {
        const text = extractTextContent(record.content)
        return text === null || !isSkippableCodexPseudoUserMessage(message, text, record.meta)
    }

    if (record.role !== 'agent') {
        return false
    }
    return isNonblankAgentOutputUserTurnStart(record.content)
}

function normalizePageLimit(limit: number): number {
    return Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50
}

function toDecryptedMessage(message: StoredMessage): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        content: message.content,
        createdAt: message.createdAt,
    }
}

function getDirection(options: MessagePageOptions): MessagePageDirection {
    if (options.beforeSeq !== null && options.afterSeq !== null) {
        throw new Error('beforeSeq and afterSeq are mutually exclusive')
    }
    if (options.afterSeq !== null) return 'newer'
    if (options.beforeSeq !== null) return 'older'
    return 'latest'
}

function emptyPage(options: MessagePageOptions, limit: number, direction: MessagePageDirection): MessagePageResult {
    return {
        messages: [],
        page: {
            limit,
            direction,
            beforeSeq: options.beforeSeq,
            afterSeq: options.afterSeq,
            nextBeforeSeq: null,
            nextAfterSeq: null,
            hasMore: false,
            hasOlder: false,
            hasNewer: false,
            range: null,
            startComplete: true,
            endComplete: true,
            continuation: null,
        },
    }
}

function readBackwardPage(
    store: MessagePageStore,
    sessionId: string,
    options: MessagePageOptions,
    limit: number,
    direction: 'latest' | 'older',
): MessagePageResult {
    let stored = store.getMessages(
        sessionId,
        limit,
        options.beforeSeq ?? undefined,
        { maxLimit: limit },
    )
    if (stored.length === 0) {
        return emptyPage(options, limit, direction)
    }

    let scanned = stored.length
    let startComplete = isLogicalTurnStart(stored[0]!)

    while (!startComplete && scanned < MESSAGE_PAGE_SCAN_BUDGET) {
        const first = stored[0]
        if (!first) break
        const readLimit = Math.min(
            MESSAGE_PAGE_SCAN_CHUNK_SIZE,
            MESSAGE_PAGE_SCAN_BUDGET - scanned,
        )
        const older = store.getMessages(
            sessionId,
            readLimit,
            first.seq,
            { maxLimit: readLimit },
        )
        scanned += older.length
        if (older.length === 0) {
            startComplete = true
            break
        }

        let boundaryIndex = -1
        for (let index = older.length - 1; index >= 0; index -= 1) {
            if (isLogicalTurnStart(older[index]!)) {
                boundaryIndex = index
                break
            }
        }

        if (boundaryIndex >= 0) {
            stored = [...older.slice(boundaryIndex), ...stored]
            startComplete = true
            break
        }

        stored = [...older, ...stored]
        if (older.length < readLimit) {
            startComplete = true
            break
        }
    }

    const first = stored[0]!
    const last = stored[stored.length - 1]!
    const hasOlder = store.getMessages(sessionId, 1, first.seq, { maxLimit: 1 }).length > 0
    const next = store.getMessagesAfter(sessionId, last.seq, 1, { maxLimit: 1 })
    const hasNewer = next.length > 0
    const endComplete = !hasNewer || isLogicalTurnStart(next[0]!)
    const continuation = startComplete
        ? null
        : { direction: 'older' as const, cursorSeq: first.seq }

    return {
        messages: stored.map(toDecryptedMessage),
        page: {
            limit,
            direction,
            beforeSeq: options.beforeSeq,
            afterSeq: options.afterSeq,
            nextBeforeSeq: first.seq,
            nextAfterSeq: last.seq,
            hasMore: hasOlder,
            hasOlder,
            hasNewer,
            range: { startSeq: first.seq, endSeq: last.seq },
            startComplete,
            endComplete,
            continuation,
        },
    }
}

function readNewerPage(
    store: MessagePageStore,
    sessionId: string,
    options: MessagePageOptions,
    limit: number,
): MessagePageResult {
    let stored = store.getMessagesAfter(
        sessionId,
        options.afterSeq ?? 0,
        limit,
        { maxLimit: limit },
    )
    if (stored.length === 0) {
        const result = emptyPage(options, limit, 'newer')
        const newestBeforeCursor = store.getMessages(
            sessionId,
            1,
            options.afterSeq === null ? undefined : options.afterSeq + 1,
            { maxLimit: 1 },
        )
        result.page.hasOlder = newestBeforeCursor.length > 0
        result.page.hasMore = result.page.hasOlder
        return result
    }

    let scanned = stored.length
    const first = stored[0]!
    const beforeFirst = store.getMessages(sessionId, 1, first.seq, { maxLimit: 1 })
    const startComplete = beforeFirst.length === 0 || isLogicalTurnStart(first)
    let endComplete = false
    let hasNewer = false

    while (!endComplete && scanned < MESSAGE_PAGE_SCAN_BUDGET) {
        const last = stored[stored.length - 1]
        if (!last) break
        const readLimit = Math.min(
            MESSAGE_PAGE_SCAN_CHUNK_SIZE,
            MESSAGE_PAGE_SCAN_BUDGET - scanned,
        )
        const newer = store.getMessagesAfter(
            sessionId,
            last.seq,
            readLimit,
            { maxLimit: readLimit },
        )
        scanned += newer.length
        if (newer.length === 0) {
            endComplete = true
            hasNewer = false
            break
        }

        const boundaryIndex = newer.findIndex(isLogicalTurnStart)
        if (boundaryIndex >= 0) {
            stored = [...stored, ...newer.slice(0, boundaryIndex)]
            endComplete = true
            hasNewer = true
            break
        }

        stored = [...stored, ...newer]
        if (newer.length < readLimit) {
            endComplete = true
            hasNewer = false
            break
        }
    }

    let last = stored[stored.length - 1]!
    if (!endComplete) {
        hasNewer = store.getMessagesAfter(sessionId, last.seq, 1, { maxLimit: 1 }).length > 0
        if (!hasNewer) {
            endComplete = true
        }
    }
    last = stored[stored.length - 1]!
    const hasOlder = store.getMessages(sessionId, 1, first.seq, { maxLimit: 1 }).length > 0
    const continuation = endComplete
        ? null
        : { direction: 'newer' as const, cursorSeq: last.seq }

    return {
        messages: stored.map(toDecryptedMessage),
        page: {
            limit,
            direction: 'newer',
            beforeSeq: options.beforeSeq,
            afterSeq: options.afterSeq,
            nextBeforeSeq: first.seq,
            nextAfterSeq: last.seq,
            hasMore: hasOlder,
            hasOlder,
            hasNewer,
            range: { startSeq: first.seq, endSeq: last.seq },
            startComplete,
            endComplete,
            continuation,
        },
    }
}

export function readCompleteMessagePage(
    store: MessagePageStore,
    sessionId: string,
    options: MessagePageOptions,
): MessagePageResult {
    const limit = normalizePageLimit(options.limit)
    const direction = getDirection(options)
    if (direction === 'newer') {
        return readNewerPage(store, sessionId, options, limit)
    }
    return readBackwardPage(store, sessionId, options, limit, direction)
}

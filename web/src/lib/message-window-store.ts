import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { isQueuedForInvocation, isUserMessage, mergeMessages } from '@/lib/messages'

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingCount: number
    hasMore: boolean
    oldestSeq: number | null
    newestSeq: number | null
    isLoading: boolean
    isLoadingMore: boolean
    warning: string | null
    atBottom: boolean
    messagesVersion: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const PENDING_WINDOW_SIZE = 200
const AGENT_RUN_WINDOW_SIZE = 800
const PAGE_SIZE = 50
const COLD_LOAD_BACKFILL_PAGE_SIZE = 200
const COLD_LOAD_REGULAR_TARGET = PAGE_SIZE
const PENDING_OVERFLOW_WARNING = 'New messages arrived while you were away. Scroll to bottom to refresh.'

type InternalState = MessageWindowState & {
    pendingOverflowCount: number
    pendingVisibleCount: number
    pendingOverflowVisibleCount: number
    // V8 composite cursor: defined when hub responded with nextBeforeAt
    oldestPositionAt: number | null
    // Paired with oldestPositionAt — the server returns both as a cursor; keep them
    // together so we don't accidentally combine `nextBeforeAt` from the server with
    // a recomputed minimum `seq` from the local window (those can refer to
    // different rows after a low-seq message is invoked late).
    oldestPositionSeq: number | null
}

type PendingVisibilityCacheEntry = {
    source: DecryptedMessage
    visible: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const pendingVisibilityCacheBySession = new Map<string, Map<string, PendingVisibilityCacheEntry>>()

// Throttled notification: coalesce rapid state updates into at most one
// notification per NOTIFY_THROTTLE_MS during streaming. This prevents
// Windows UI jank caused by excessive React re-renders during SSE streaming.
const NOTIFY_THROTTLE_MS = 150
const pendingNotifySessionIds = new Set<string>()
let notifyRafId: ReturnType<typeof requestAnimationFrame> | null = null
let lastNotifyAt = 0

function scheduleNotify(sessionId: string): void {
    pendingNotifySessionIds.add(sessionId)
    if (notifyRafId !== null) {
        return
    }
    const elapsed = Date.now() - lastNotifyAt
    if (elapsed >= NOTIFY_THROTTLE_MS) {
        // Enough time has passed — flush on next animation frame
        notifyRafId = requestAnimationFrame(flushNotifications)
    } else {
        // Too soon — delay until the throttle window expires, then use rAF
        const remaining = NOTIFY_THROTTLE_MS - elapsed
        setTimeout(() => {
            notifyRafId = requestAnimationFrame(flushNotifications)
        }, remaining)
        // Use a sentinel so we don't double-schedule
        notifyRafId = -1 as unknown as ReturnType<typeof requestAnimationFrame>
    }
}

function flushNotifications(): void {
    notifyRafId = null
    lastNotifyAt = Date.now()
    const sessionIds = Array.from(pendingNotifySessionIds)
    pendingNotifySessionIds.clear()
    for (const sessionId of sessionIds) {
        const subs = listeners.get(sessionId)
        if (!subs) continue
        for (const listener of subs) {
            listener()
        }
    }
}

function getPendingVisibilityCache(sessionId: string): Map<string, PendingVisibilityCacheEntry> {
    const existing = pendingVisibilityCacheBySession.get(sessionId)
    if (existing) {
        return existing
    }
    const created = new Map<string, PendingVisibilityCacheEntry>()
    pendingVisibilityCacheBySession.set(sessionId, created)
    return created
}

function clearPendingVisibilityCache(sessionId: string): void {
    pendingVisibilityCacheBySession.delete(sessionId)
}

function isVisiblePendingMessage(sessionId: string, message: DecryptedMessage): boolean {
    const cache = getPendingVisibilityCache(sessionId)
    const cached = cache.get(message.id)
    if (cached && cached.source === message) {
        return cached.visible
    }
    const visible = normalizeDecryptedMessage(message) !== null
    cache.set(message.id, { source: message, visible })
    return visible
}

function countVisiblePendingMessages(sessionId: string, messages: DecryptedMessage[]): number {
    let count = 0
    for (const message of messages) {
        if (isVisiblePendingMessage(sessionId, message)) {
            count += 1
        }
    }
    return count
}

function syncPendingVisibilityCache(sessionId: string, pending: DecryptedMessage[]): void {
    const cache = pendingVisibilityCacheBySession.get(sessionId)
    if (!cache) {
        return
    }
    const keep = new Set(pending.map((message) => message.id))
    for (const id of cache.keys()) {
        if (!keep.has(id)) {
            cache.delete(id)
        }
    }
}

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        pending: [],
        pendingCount: 0,
        pendingVisibleCount: 0,
        pendingOverflowVisibleCount: 0,
        hasMore: false,
        oldestSeq: null,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestSeq: null,
        isLoading: false,
        isLoadingMore: false,
        warning: null,
        atBottom: true,
        messagesVersion: 0,
        pendingOverflowCount: 0,
    }
}

function getState(sessionId: string): InternalState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notify(sessionId: string): void {
    scheduleNotify(sessionId)
}

function notifyImmediate(sessionId: string): void {
    // Bypass throttle for user-initiated actions (flush, clear, etc.)
    const subs = listeners.get(sessionId)
    if (!subs) return
    for (const listener of subs) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState, immediate?: boolean): void {
    states.set(sessionId, next)
    if (immediate) {
        notifyImmediate(sessionId)
    } else {
        notify(sessionId)
    }
}

function updateState(sessionId: string, updater: (prev: InternalState) => InternalState, immediate?: boolean): void {
    const prev = getState(sessionId)
    const next = updater(prev)
    if (next !== prev) {
        setState(sessionId, next, immediate)
    }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
    let oldest: number | null = null
    let newest: number | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') {
            continue
        }
        if (oldest === null || message.seq < oldest) {
            oldest = message.seq
        }
        if (newest === null || message.seq > newest) {
            newest = message.seq
        }
    }
    return { oldestSeq: oldest, newestSeq: newest }
}

function getMessagePositionAt(message: DecryptedMessage): number {
    return message.invokedAt ?? message.createdAt
}

function deriveOldestPosition(messages: DecryptedMessage[]): { at: number; seq: number } | null {
    let oldest: DecryptedMessage | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') continue
        if (!oldest) {
            oldest = message
            continue
        }
        const messageAt = getMessagePositionAt(message)
        const oldestAt = getMessagePositionAt(oldest)
        if (messageAt < oldestAt || (messageAt === oldestAt && message.seq < oldest.seq!)) {
            oldest = message
        }
    }
    return oldest && typeof oldest.seq === 'number'
        ? { at: getMessagePositionAt(oldest), seq: oldest.seq }
        : null
}

function isCodexAgentRunMessage(message: DecryptedMessage): boolean {
    const content = message.content
    if (!content || typeof content !== 'object') return false
    const outer = content as { role?: unknown; content?: unknown }
    if (outer.role !== 'agent') return false
    const inner = outer.content
    if (!inner || typeof inner !== 'object') return false
    const payload = inner as { type?: unknown; data?: unknown }
    if (payload.type !== 'codex') return false
    const data = payload.data
    if (!data || typeof data !== 'object') return false
    const eventType = (data as { type?: unknown }).type
    return eventType === 'agent-run-start'
        || eventType === 'agent-run-update'
        || eventType === 'agent-run-trace'
}

function countRegularMessages(messages: DecryptedMessage[]): number {
    let count = 0
    const seen = new Set<string>()
    for (const message of messages) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        if (!isCodexAgentRunMessage(message)) {
            count += 1
        }
    }
    return count
}

function hasV8Cursor(response: MessagesResponse): boolean {
    return response.page.nextBeforeAt !== undefined
        && response.page.nextBeforeAt !== null
        && response.page.nextBeforeSeq !== null
}

function sameCursor(a: MessagesResponse, b: MessagesResponse): boolean {
    return (a.page.nextBeforeAt ?? null) === (b.page.nextBeforeAt ?? null)
        && a.page.nextBeforeSeq === b.page.nextBeforeSeq
}

async function backfillColdLoadMessages(
    api: ApiClient,
    sessionId: string,
    first: MessagesResponse
): Promise<MessagesResponse> {
    let combined = first
    let regularCount = countRegularMessages(combined.messages)

    // On a cold reload the hub's latest page can be filled entirely by Codex
    // child-agent trace updates. The live path protects regular/root messages
    // with a separate client budget, but that cannot help if those messages were
    // never fetched. Walk older pages until the initial window has a small root
    // conversation floor, or until history is exhausted.
    while (combined.page.hasMore && regularCount < COLD_LOAD_REGULAR_TARGET) {
        if (combined.page.nextBeforeSeq === null) break

        const older = hasV8Cursor(combined)
            ? await api.getMessages(sessionId, {
                byPosition: true,
                beforeAt: combined.page.nextBeforeAt!,
                beforeSeq: combined.page.nextBeforeSeq,
                limit: COLD_LOAD_BACKFILL_PAGE_SIZE
            })
            : await api.getMessages(sessionId, {
                beforeSeq: combined.page.nextBeforeSeq,
                limit: COLD_LOAD_BACKFILL_PAGE_SIZE
            })

        if (older.messages.length === 0 || sameCursor(combined, older)) {
            combined = {
                messages: combined.messages,
                page: {
                    ...combined.page,
                    hasMore: false
                }
            }
            break
        }

        combined = {
            messages: mergeMessages(older.messages, combined.messages),
            page: older.page
        }
        regularCount = countRegularMessages(combined.messages)
    }

    return combined
}

function sliceForTrim<T>(items: T[], limit: number, mode: 'append' | 'prepend'): { kept: T[]; dropped: T[] } {
    if (items.length <= limit) {
        return { kept: items, dropped: [] }
    }
    if (limit <= 0) {
        return { kept: [], dropped: items }
    }
    const kept = mode === 'prepend'
        ? items.slice(0, limit)
        : items.slice(items.length - limit)
    const dropped = mode === 'prepend'
        ? items.slice(limit)
        : items.slice(0, items.length - limit)
    return { kept, dropped }
}

function buildState(
    prev: InternalState,
    updates: {
        messages?: DecryptedMessage[]
        pending?: DecryptedMessage[]
        pendingOverflowCount?: number
        pendingVisibleCount?: number
        pendingOverflowVisibleCount?: number
        hasMore?: boolean
        oldestPositionAt?: number | null
        oldestPositionSeq?: number | null
        isLoading?: boolean
        isLoadingMore?: boolean
        warning?: string | null
        atBottom?: boolean
    }
): InternalState {
    const messages = updates.messages ?? prev.messages
    const pending = updates.pending ?? prev.pending
    const pendingOverflowCount = updates.pendingOverflowCount ?? prev.pendingOverflowCount
    const pendingOverflowVisibleCount = updates.pendingOverflowVisibleCount ?? prev.pendingOverflowVisibleCount
    let pendingVisibleCount = updates.pendingVisibleCount ?? prev.pendingVisibleCount
    const pendingChanged = pending !== prev.pending
    if (pendingChanged && updates.pendingVisibleCount === undefined) {
        pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    }
    if (pendingChanged) {
        syncPendingVisibilityCache(prev.sessionId, pending)
    }
    const pendingCount = pendingVisibleCount + pendingOverflowVisibleCount
    const { oldestSeq, newestSeq } = deriveSeqBounds(messages)
    const messagesVersion = messages === prev.messages ? prev.messagesVersion : prev.messagesVersion + 1

    return {
        ...prev,
        messages,
        pending,
        pendingOverflowCount,
        pendingVisibleCount,
        pendingOverflowVisibleCount,
        pendingCount,
        oldestSeq,
        oldestPositionAt: updates.oldestPositionAt !== undefined ? updates.oldestPositionAt : prev.oldestPositionAt,
        oldestPositionSeq: updates.oldestPositionSeq !== undefined ? updates.oldestPositionSeq : prev.oldestPositionSeq,
        newestSeq,
        hasMore: updates.hasMore !== undefined ? updates.hasMore : prev.hasMore,
        isLoading: updates.isLoading !== undefined ? updates.isLoading : prev.isLoading,
        isLoadingMore: updates.isLoadingMore !== undefined ? updates.isLoadingMore : prev.isLoadingMore,
        warning: updates.warning !== undefined ? updates.warning : prev.warning,
        atBottom: updates.atBottom !== undefined ? updates.atBottom : prev.atBottom,
        messagesVersion,
    }
}

/** Trim `messages` down to `limit` while preserving every queued user message.
 *  Queued rows must survive trimming on both windows: the `messages-consumed`
 *  SSE only carries localIds, so a dropped queued row cannot be restored or
 *  repositioned without a full refetch.  Returns the kept slice plus the list
 *  of regular (non-queued) rows that were dropped, so the pending-overflow
 *  warning counter can be advanced symmetrically. */
function trimPreservingQueued(
    messages: DecryptedMessage[],
    limit: number,
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
    if (messages.length <= limit) {
        return { kept: messages, dropped: [] }
    }
    const queued = messages.filter(isQueuedForInvocation)
    const queuedIds = new Set(queued.map((message) => message.id))
    const nonQueued = messages.filter((message) => !queuedIds.has(message.id))
    const agentRun = nonQueued.filter(isCodexAgentRunMessage)
    const regular = nonQueued.filter((message) => !isCodexAgentRunMessage(message))
    const budget = Math.max(0, limit - queued.length)
    const regularTrim = sliceForTrim(regular, budget, mode)
    const agentRunTrim = sliceForTrim(agentRun, AGENT_RUN_WINDOW_SIZE, mode)
    return {
        kept: mergeMessages([...regularTrim.kept, ...agentRunTrim.kept], queued),
        dropped: [...regularTrim.dropped, ...agentRunTrim.dropped]
    }
}

function trimVisible(messages: DecryptedMessage[], mode: 'append' | 'prepend'): DecryptedMessage[] {
    return trimPreservingQueued(messages, VISIBLE_WINDOW_SIZE, mode).kept
}

function trimVisibleWithDropped(
    messages: DecryptedMessage[],
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
    return trimPreservingQueued(messages, VISIBLE_WINDOW_SIZE, mode)
}

function cursorUpdatesAfterAppendTrim(
    kept: DecryptedMessage[],
    dropped: DecryptedMessage[]
): {
    hasMore?: boolean
    oldestPositionAt?: number | null
    oldestPositionSeq?: number | null
} {
    if (dropped.length === 0) {
        return {}
    }
    const oldest = deriveOldestPosition(kept)
    return {
        hasMore: true,
        ...(oldest ? {
            oldestPositionAt: oldest.at,
            oldestPositionSeq: oldest.seq
        } : {})
    }
}

function trimPending(
    sessionId: string,
    messages: DecryptedMessage[]
): { pending: DecryptedMessage[]; dropped: number; droppedVisible: number } {
    if (messages.length <= PENDING_WINDOW_SIZE) {
        return { pending: messages, dropped: 0, droppedVisible: 0 }
    }
    // Symmetric with trimVisible: agents that overflow the pending window
    // (200) must not evict queued user messages — the floating bar holds the
    // only client-visible reference to them until the CLI ack arrives.
    const { kept, dropped } = trimPreservingQueued(messages, PENDING_WINDOW_SIZE, 'append')
    const droppedVisible = countVisiblePendingMessages(sessionId, dropped)
    return { pending: kept, dropped: dropped.length, droppedVisible }
}

function filterPendingAgainstVisible(pending: DecryptedMessage[], visible: DecryptedMessage[]): DecryptedMessage[] {
    if (pending.length === 0 || visible.length === 0) {
        return pending
    }
    const visibleIds = new Set(visible.map((message) => message.id))
    return pending.filter((message) => !visibleIds.has(message.id))
}

function isOptimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function mergeIntoPending(
    prev: InternalState,
    incoming: DecryptedMessage[]
): {
    pending: DecryptedMessage[]
    pendingVisibleCount: number
    pendingOverflowCount: number
    pendingOverflowVisibleCount: number
    warning: string | null
} {
    if (incoming.length === 0) {
        return {
            pending: prev.pending,
            pendingVisibleCount: prev.pendingVisibleCount,
            pendingOverflowCount: prev.pendingOverflowCount,
            pendingOverflowVisibleCount: prev.pendingOverflowVisibleCount,
            warning: prev.warning
        }
    }
    const mergedPending = mergeMessages(prev.pending, incoming)
    const filtered = filterPendingAgainstVisible(mergedPending, prev.messages)
    const { pending, dropped, droppedVisible } = trimPending(prev.sessionId, filtered)
    const pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    const pendingOverflowCount = prev.pendingOverflowCount + dropped
    const pendingOverflowVisibleCount = prev.pendingOverflowVisibleCount + droppedVisible
    const warning = droppedVisible > 0 && !prev.warning ? PENDING_OVERFLOW_WARNING : prev.warning
    return { pending, pendingVisibleCount, pendingOverflowCount, pendingOverflowVisibleCount, warning }
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    const subs = listeners.get(sessionId) ?? new Set()
    subs.add(listener)
    listeners.set(sessionId, subs)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
            states.delete(sessionId)
            clearPendingVisibilityCache(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    clearPendingVisibilityCache(sessionId)
    if (!states.has(sessionId)) {
        return
    }
    setState(sessionId, createState(sessionId), true)
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
        return
    }
    const source = getState(fromSessionId)
    const base = createState(toSessionId)
    const next = buildState(base, {
        messages: [...source.messages],
        pending: [...source.pending],
        pendingOverflowCount: source.pendingOverflowCount,
        pendingOverflowVisibleCount: source.pendingOverflowVisibleCount,
        hasMore: source.hasMore,
        oldestPositionAt: source.oldestPositionAt,
        oldestPositionSeq: source.oldestPositionSeq,
        warning: source.warning,
        atBottom: source.atBottom,
        isLoading: false,
        isLoadingMore: false,
    })
    setState(toSessionId, next)
}

export async function fetchLatestMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoading) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoading: true, warning: null }))

    try {
        // Always request byPosition mode (V8). If the hub is V7 it ignores byPosition and
        // returns the standard seq-based response (no nextBeforeAt field) — we fall back
        // to seq-cursor mode seamlessly.
        const firstResponse = await api.getMessages(sessionId, { byPosition: true, limit: PAGE_SIZE })
        const response = initial.atBottom
            ? await backfillColdLoadMessages(api, sessionId, firstResponse)
            : firstResponse
        // Derive composite cursor pair from server response. Both values come from
        // the same row on the server; we keep them paired so the next older fetch
        // doesn't mix `beforeAt` from the server with a recomputed minimum `seq`.
        const nextBeforeAt = response.page.nextBeforeAt ?? null
        const nextBeforeSeq = response.page.nextBeforeSeq ?? null
        const isV8Cursor = nextBeforeAt !== null && nextBeforeSeq !== null

        updateState(sessionId, (prev) => {
            if (prev.atBottom) {
                const merged = mergeMessages(prev.messages, [...prev.pending, ...response.messages])
                const trimmed = trimVisible(merged, 'append')
                return buildState(prev, {
                    messages: trimmed,
                    pending: [],
                    pendingOverflowCount: 0,
                    pendingVisibleCount: 0,
                    pendingOverflowVisibleCount: 0,
                    hasMore: response.page.hasMore,
                    oldestPositionAt: isV8Cursor ? nextBeforeAt : null,
                    oldestPositionSeq: isV8Cursor ? nextBeforeSeq : null,
                    isLoading: false,
                    warning: null,
                })
            }
            const pendingResult = mergeIntoPending(prev, response.messages)
            return buildState(prev, {
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
                // Persist the V8 cursor pair on the non-at-bottom path too. Without this
                // a refresh while scrolled up dropped the composite cursor and the next
                // loadMore fell back to V7 seq mode against a V8 hub — the same
                // asymmetric class of bug the at-bottom branch already guards against.
                oldestPositionAt: isV8Cursor ? nextBeforeAt : null,
                oldestPositionSeq: isV8Cursor ? nextBeforeSeq : null,
                isLoading: false,
                warning: pendingResult.warning,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoading: false, warning: message }))
    }
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoadingMore || !initial.hasMore) {
        return
    }
    if (initial.oldestSeq === null) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: true }))

    try {
        // V8 mode: use the server-provided cursor pair as-is. Mixing `beforeAt` from
        // the server with a recomputed minimum `seq` from the local window can refer
        // to different rows after a low-seq message is invoked late.
        const useV8Cursor = initial.oldestPositionAt !== null && initial.oldestPositionSeq !== null
        const response = useV8Cursor
            ? await api.getMessages(sessionId, {
                byPosition: true,
                beforeAt: initial.oldestPositionAt!,
                beforeSeq: initial.oldestPositionSeq!,
                limit: PAGE_SIZE
            })
            : await api.getMessages(sessionId, { beforeSeq: initial.oldestSeq, limit: PAGE_SIZE })

        const nextBeforeAt = response.page.nextBeforeAt ?? null
        const nextBeforeSeq = response.page.nextBeforeSeq ?? null
        const isV8Cursor = nextBeforeAt !== null && nextBeforeSeq !== null

        updateState(sessionId, (prev) => {
            const merged = mergeMessages(response.messages, prev.messages)
            const trimmed = trimVisible(merged, 'prepend')
            return buildState(prev, {
                messages: trimmed,
                hasMore: response.page.hasMore,
                oldestPositionAt: isV8Cursor ? nextBeforeAt : null,
                oldestPositionSeq: isV8Cursor ? nextBeforeSeq : null,
                isLoadingMore: false,
            })
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => buildState(prev, { isLoadingMore: false, warning: message }))
    }
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) {
        return
    }
    updateState(sessionId, (prev) => {
        if (prev.atBottom) {
            const merged = mergeMessages(prev.messages, incoming)
            const { kept, dropped } = trimVisibleWithDropped(merged, 'append')
            const pending = filterPendingAgainstVisible(prev.pending, kept)
            return buildState(prev, {
                messages: kept,
                pending,
                ...cursorUpdatesAfterAppendTrim(kept, dropped)
            })
        }
        // 不在底部时：agent 消息立即显示，user 消息才放入 pending
        // 原因：用户必须看到 AI 回复才能继续交互，pending 机制会导致回复滞后
        const agentMessages = incoming.filter(msg => !isUserMessage(msg))
        const userMessages = incoming.filter(msg => isUserMessage(msg))

        let state = prev
        if (agentMessages.length > 0) {
            const merged = mergeMessages(state.messages, agentMessages)
            const { kept, dropped } = trimVisibleWithDropped(merged, 'append')
            const pending = filterPendingAgainstVisible(state.pending, kept)
            state = buildState(state, {
                messages: kept,
                pending,
                ...cursorUpdatesAfterAppendTrim(kept, dropped)
            })
        }
        if (userMessages.length > 0) {
            const pendingResult = mergeIntoPending(state, userMessages)
            state = buildState(state, {
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflowCount: pendingResult.pendingOverflowCount,
                pendingOverflowVisibleCount: pendingResult.pendingOverflowVisibleCount,
                warning: pendingResult.warning,
            })
        }
        return state
    })
}

export function flushPendingMessages(sessionId: string): boolean {
    const current = getState(sessionId)
    if (current.pending.length === 0 && current.pendingOverflowVisibleCount === 0) {
        return false
    }
    const needsRefresh = current.pendingOverflowVisibleCount > 0
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, prev.pending)
        const { kept, dropped } = trimVisibleWithDropped(merged, 'append')
        return buildState(prev, {
            messages: kept,
            pending: [],
            pendingOverflowCount: 0,
            pendingVisibleCount: 0,
            pendingOverflowVisibleCount: 0,
            warning: needsRefresh ? (prev.warning ?? PENDING_OVERFLOW_WARNING) : prev.warning,
            ...cursorUpdatesAfterAppendTrim(kept, dropped)
        })
    }, true)
    return needsRefresh
}

export function setAtBottom(sessionId: string, atBottom: boolean): void {
    updateState(sessionId, (prev) => {
        if (prev.atBottom === atBottom) {
            return prev
        }
        return buildState(prev, { atBottom })
    }, true)
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, [message])
        const { kept, dropped } = trimVisibleWithDropped(merged, 'append')
        const pending = filterPendingAgainstVisible(prev.pending, kept)
        return buildState(prev, {
            messages: kept,
            pending,
            atBottom: true,
            ...cursorUpdatesAfterAppendTrim(kept, dropped)
        })
    }, true)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    if (!localId) {
        return
    }
    updateState(sessionId, (prev) => {
        let changed = false
        const updateList = (list: DecryptedMessage[]) => {
            return list.map((message) => {
                if (message.localId !== localId) {
                    return message
                }
                if (message.status === status) {
                    return message
                }
                changed = true
                return { ...message, status }
            })
        }
        const messages = updateList(prev.messages)
        const pending = updateList(prev.pending)
        if (!changed) {
            return prev
        }
        return buildState(prev, { messages, pending })
    })
}

/** Remove an optimistic (not-yet-confirmed) message by its localId or server id.
 *  Used by the cancel affordance: optimistically drop the row immediately so the
 *  floating bar clears before the DELETE /messages/:id round-trip completes. If
 *  the request fails, the caller is responsible for re-inserting the row (e.g.
 *  via ingestIncomingMessages).  Matches against both `localId` and `id` so that
 *  rows loaded from the server (which may have a stable uuid `id` + a localId) are
 *  also handled.
 */
export function removeOptimisticMessage(sessionId: string, localId: string): void {
    if (!localId) return
    updateState(sessionId, (prev) => {
        let changed = false
        const filterList = (list: DecryptedMessage[]) => {
            const next = list.filter((message) => {
                const matchesLocalId = message.localId === localId
                const matchesId = message.id === localId
                if (matchesLocalId || matchesId) {
                    changed = true
                    return false
                }
                return true
            })
            return next
        }
        const messages = filterList(prev.messages)
        const pending = filterList(prev.pending)
        if (!changed) return prev
        return buildState(prev, { messages, pending })
    }, true)
}

/** Transition the queued messages whose localIds match to 'sent' and record invokedAt.
 *  Driven by the CLI ack (messages-consumed). Unmatched messages remain queued.
 *  Also handles server-loaded messages (status=undefined) that have a matching localId.
 *  V7 hub compat: if `invokedAt` is undefined the SyncEvent had no server timestamp,
 *  so we fall back to client time — without it the row would stay queued forever
 *  under the strict-null filter. The fallback only affects display ordering on
 *  this client; the persisted server value is the authoritative one when present. */
export function markMessagesConsumed(sessionId: string, localIds: string[], invokedAt: number | undefined): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    const effectiveInvokedAt = invokedAt ?? Date.now()
    updateState(sessionId, (prev) => {
        let changed = false
        const updateList = (list: DecryptedMessage[]) => {
            return list.map((message) => {
                if (!message.localId || !idSet.has(message.localId)) {
                    return message
                }
                if (message.status === 'failed') {
                    return message
                }
                // Apply the ack even if the message is already 'sent' (optimistic) — otherwise
                // a message that flipped to 'sent' before the consume event arrives would
                // never receive `invokedAt` and keep sorting by send time.
                // First-write-wins on `invokedAt`: mirror the hub's UPDATE guard so a
                // duplicate `messages-consumed` (e.g. CLI re-emit) doesn't restamp a
                // message and shuffle its byPosition slot on live clients while the
                // DB still holds the original timestamp.
                const needsStatus = message.status !== 'sent'
                // Strict null to stay consistent with isQueuedForInvocation and the rest
                // of this file. The idSet filter already shields V7-stamped rows from
                // this path, but the strict-null contract should not vary by call site.
                const needsInvokedAt = message.invokedAt === null
                if (!needsStatus && !needsInvokedAt) {
                    return message
                }
                changed = true
                const update: Partial<DecryptedMessage> = {}
                if (needsStatus) {
                    update.status = 'sent' as MessageStatus
                }
                if (needsInvokedAt) {
                    update.invokedAt = effectiveInvokedAt
                }
                return { ...message, ...update }
            })
        }
        // Migrate just-acked pending entries into the visible thread. Without
        // this step, an at-bottom=false user that is stuck in pending never
        // sees their own message at the invocation slot — it stays in the
        // pending bucket until they scroll, even though the floating bar
        // already cleared.  Identifying the migrated rows by (localId,
        // invokedAt = effectiveInvokedAt) ensures we only move rows whose
        // ack just arrived, not unrelated pending entries.
        const updatedPending = updateList(prev.pending)
        const consumedFromPending: DecryptedMessage[] = []
        const remainingPending = updatedPending.filter((message) => {
            if (
                message.localId &&
                idSet.has(message.localId) &&
                message.invokedAt === effectiveInvokedAt
            ) {
                consumedFromPending.push(message)
                return false
            }
            return true
        })
        // After update, re-merge to re-sort by the position key (`invokedAt ?? createdAt`):
        // a queued message that just received `invokedAt` should move to its invocation
        // position, not stay at its original send-time slot until the next fetch.
        const mergedMessages = mergeMessages(updateList(prev.messages), consumedFromPending)
        const { kept, dropped } = trimVisibleWithDropped(mergedMessages, 'append')
        const pending = mergeMessages([], remainingPending)
        if (!changed) {
            return prev
        }
        return buildState(prev, {
            messages: kept,
            pending,
            ...cursorUpdatesAfterAppendTrim(kept, dropped)
        })
    })
}

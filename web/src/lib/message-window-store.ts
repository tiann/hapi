import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus } from '@/types/api'
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
const PAGE_SIZE = 50
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
    if (queued.length === 0) {
        const kept = mode === 'prepend'
            ? messages.slice(0, limit)
            : messages.slice(messages.length - limit)
        const dropped = mode === 'prepend'
            ? messages.slice(limit)
            : messages.slice(0, messages.length - limit)
        return { kept, dropped }
    }
    const queuedIds = new Set(queued.map((message) => message.id))
    const regular = messages.filter((message) => !queuedIds.has(message.id))
    const budget = Math.max(0, limit - queued.length)
    const trimmedRegular = mode === 'prepend'
        ? regular.slice(0, budget)
        : regular.slice(Math.max(0, regular.length - budget))
    const droppedRegular = mode === 'prepend'
        ? regular.slice(budget)
        : regular.slice(0, Math.max(0, regular.length - budget))
    return { kept: mergeMessages(trimmedRegular, queued), dropped: droppedRegular }
}

function trimVisible(messages: DecryptedMessage[], mode: 'append' | 'prepend'): DecryptedMessage[] {
    return trimPreservingQueued(messages, VISIBLE_WINDOW_SIZE, mode).kept
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
        const response = await api.getMessages(sessionId, { byPosition: true, limit: PAGE_SIZE })
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
            const trimmed = trimVisible(merged, 'append')
            const pending = filterPendingAgainstVisible(prev.pending, trimmed)
            return buildState(prev, { messages: trimmed, pending })
        }
        // 不在底部时：agent 消息立即显示，user 消息才放入 pending
        // 原因：用户必须看到 AI 回复才能继续交互，pending 机制会导致回复滞后
        const agentMessages = incoming.filter(msg => !isUserMessage(msg))
        const userMessages = incoming.filter(msg => isUserMessage(msg))

        let state = prev
        if (agentMessages.length > 0) {
            const merged = mergeMessages(state.messages, agentMessages)
            const trimmed = trimVisible(merged, 'append')
            const pending = filterPendingAgainstVisible(state.pending, trimmed)
            state = buildState(state, { messages: trimmed, pending })
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
        const trimmed = trimVisible(merged, 'append')
        return buildState(prev, {
            messages: trimmed,
            pending: [],
            pendingOverflowCount: 0,
            pendingVisibleCount: 0,
            pendingOverflowVisibleCount: 0,
            warning: needsRefresh ? (prev.warning ?? PENDING_OVERFLOW_WARNING) : prev.warning,
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
        const trimmed = trimVisible(merged, 'append')
        const pending = filterPendingAgainstVisible(prev.pending, trimmed)
        return buildState(prev, { messages: trimmed, pending, atBottom: true })
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
        const messages = mergeMessages(updateList(prev.messages), consumedFromPending)
        const pending = mergeMessages([], remainingPending)
        if (!changed) {
            return prev
        }
        return buildState(prev, { messages, pending })
    })
}

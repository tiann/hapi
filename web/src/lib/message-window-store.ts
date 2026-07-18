import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { mergeMessages } from '@/lib/messages'
import {
    deriveSequenceCoverage,
    PENDING_WINDOW_TURN_LIMIT,
    trimToCompleteTurns,
    VISIBLE_WINDOW_TURN_LIMIT,
    type SequenceGap,
    type SequenceRange,
} from '@/lib/message-turns'

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingCount: number
    hasOlder: boolean
    hasNewer: boolean
    hasMore: boolean
    ranges: SequenceRange[]
    gaps: SequenceGap[]
    oldestSeq: number | null
    newestSeq: number | null
    isLoading: boolean
    isLoadingOlder: boolean
    isLoadingNewer: boolean
    isLoadingMore: boolean
    warning: string | null
    atBottom: boolean
    messagesVersion: number
}

export { PENDING_WINDOW_TURN_LIMIT, VISIBLE_WINDOW_TURN_LIMIT }
export const MESSAGE_WINDOW_IDLE_TTL_MS = 5 * 60 * 1000
export const MAX_IDLE_MESSAGE_WINDOWS = 10
const LATEST_PAGE_ROW_TARGET = 50
// A complete Hub response contains no more logical turns than its raw-row target.
// Keeping directional targets at half the visible turn budget guarantees that a
// prepend/append retains an overlapping half-window for stable anchor restoration.
const DIRECTIONAL_PAGE_ROW_TARGET = Math.floor(VISIBLE_WINDOW_TURN_LIMIT / 2)
const MAX_PAGE_CONTINUATIONS = 20
const MAX_EXACT_LATEST_STABILIZATION_ATTEMPTS = 3
const PENDING_OVERFLOW_WARNING = 'New messages arrived while you were away. Scroll to bottom to refresh.'
const EXACT_LATEST_UNSTABLE_WARNING = 'New messages kept arriving before the latest snapshot stabilized. Try returning to latest again.'
const MESSAGE_GAP_WARNING_PREFIX = 'Message history contains a sequence gap'

type InternalState = MessageWindowState & {
    pendingVisibleCount: number
    pendingOverflow: ReadonlyMap<string, boolean>
    knownServerNewestSeq: number | null
    replacementGeneration: number
    lifecycleEpoch: number
}

type PendingVisibilityCacheEntry = {
    source: DecryptedMessage
    visible: boolean
}

type LatestFetchOptions = {
    markRead?: boolean
    forceReplace?: boolean
    revalidateAfterActive?: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const pendingVisibilityCacheBySession = new Map<string, Map<string, PendingVisibilityCacheEntry>>()
const idleCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
const latestFetchPromises = new Map<string, Promise<boolean>>()
const queuedLatestRevalidationPromises = new Map<string, Promise<boolean>>()
let nextReplacementGeneration = 1
let nextLifecycleEpoch = 1

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

function clearIdleCleanup(sessionId: string): void {
    const timer = idleCleanupTimers.get(sessionId)
    if (!timer) {
        return
    }
    clearTimeout(timer)
    idleCleanupTimers.delete(sessionId)
}

function deleteMessageWindowState(sessionId: string): void {
    states.delete(sessionId)
    latestFetchPromises.delete(sessionId)
    queuedLatestRevalidationPromises.delete(sessionId)
    clearPendingVisibilityCache(sessionId)
    pendingNotifySessionIds.delete(sessionId)
}

function isCurrentLifecycleEpoch(sessionId: string, lifecycleEpoch: number): boolean {
    return states.get(sessionId)?.lifecycleEpoch === lifecycleEpoch
}

function invalidateMessageWindowRequests(sessionId: string): void {
    latestFetchPromises.delete(sessionId)
    queuedLatestRevalidationPromises.delete(sessionId)
}

function hasUnmatchedOptimisticMessage(state: InternalState | undefined): boolean {
    return Boolean(state && [...state.messages, ...state.pending].some(isOptimisticMessage))
}

function evictOldestIdleWindowsIfNeeded(): void {
    while (idleCleanupTimers.size > MAX_IDLE_MESSAGE_WINDOWS) {
        const oldestEvictableSessionId = Array.from(idleCleanupTimers.keys()).find((sessionId) => (
            !hasUnmatchedOptimisticMessage(states.get(sessionId))
        ))
        if (!oldestEvictableSessionId) {
            return
        }
        clearIdleCleanup(oldestEvictableSessionId)
        deleteMessageWindowState(oldestEvictableSessionId)
    }
}

function scheduleIdleCleanup(sessionId: string): void {
    clearIdleCleanup(sessionId)
    const lifecycleEpoch = states.get(sessionId)?.lifecycleEpoch ?? null
    let timer!: ReturnType<typeof setTimeout>
    timer = setTimeout(() => {
        if (idleCleanupTimers.get(sessionId) !== timer) {
            return
        }
        idleCleanupTimers.delete(sessionId)
        const current = states.get(sessionId)
        if (!current || current.lifecycleEpoch !== lifecycleEpoch) {
            if (current && !listeners.has(sessionId)) {
                scheduleIdleCleanup(sessionId)
            }
            return
        }
        if (hasUnmatchedOptimisticMessage(current)) {
            return
        }
        deleteMessageWindowState(sessionId)
    }, MESSAGE_WINDOW_IDLE_TTL_MS)
    idleCleanupTimers.set(sessionId, timer)
    evictOldestIdleWindowsIfNeeded()
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
        hasOlder: false,
        hasNewer: false,
        hasMore: false,
        ranges: [],
        gaps: [],
        oldestSeq: null,
        newestSeq: null,
        isLoading: false,
        isLoadingOlder: false,
        isLoadingNewer: false,
        isLoadingMore: false,
        warning: null,
        atBottom: true,
        messagesVersion: 0,
        pendingOverflow: new Map(),
        knownServerNewestSeq: null,
        replacementGeneration: nextReplacementGeneration++,
        lifecycleEpoch: nextLifecycleEpoch++,
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
    if (!listeners.has(sessionId) && !idleCleanupTimers.has(sessionId)) {
        scheduleIdleCleanup(sessionId)
    }
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
        pendingOverflow?: ReadonlyMap<string, boolean>
        pendingVisibleCount?: number
        knownServerNewestSeq?: number | null
        hasOlder?: boolean
        hasNewer?: boolean
        hasMore?: boolean
        isLoading?: boolean
        isLoadingOlder?: boolean
        isLoadingNewer?: boolean
        isLoadingMore?: boolean
        warning?: string | null
        atBottom?: boolean
        replacementGeneration?: number
    }
): InternalState {
    const messages = updates.messages ?? prev.messages
    const pending = updates.pending ?? prev.pending
    let pendingOverflow = updates.pendingOverflow ?? prev.pendingOverflow
    let pendingVisibleCount = updates.pendingVisibleCount ?? prev.pendingVisibleCount
    const pendingChanged = pending !== prev.pending
    if (pendingChanged && updates.pendingVisibleCount === undefined) {
        pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    }
    if (pendingChanged) {
        syncPendingVisibilityCache(prev.sessionId, pending)
    }
    if (pendingOverflow.size > 0 && (
        messages !== prev.messages
        || pending !== prev.pending
        || updates.pendingOverflow !== undefined
    )) {
        const representedIds = new Set([...messages, ...pending].map((message) => message.id))
        const retainedOverflow = new Map(
            Array.from(pendingOverflow.entries()).filter(([id]) => !representedIds.has(id)),
        )
        if (retainedOverflow.size !== pendingOverflow.size) {
            pendingOverflow = retainedOverflow
        }
    }
    const pendingOverflowVisibleCount = Array.from(pendingOverflow.values())
        .filter(Boolean)
        .length
    const pendingCount = pendingVisibleCount + pendingOverflowVisibleCount
    const representedServerNewestSeq = newestServerSequence([...messages, ...pending])
    const knownServerNewestSeq = [
        prev.knownServerNewestSeq,
        updates.knownServerNewestSeq,
        representedServerNewestSeq,
    ].reduce<number | null>((newest, candidate) => (
        typeof candidate === 'number' && (newest === null || candidate > newest)
            ? candidate
            : newest
    ), null)
    const { oldestSeq, newestSeq } = deriveSeqBounds(messages)
    const { ranges, gaps } = deriveSequenceCoverage(messages)
    const messagesVersion = messages === prev.messages ? prev.messagesVersion : prev.messagesVersion + 1
    const hasOlder = updates.hasOlder ?? updates.hasMore ?? prev.hasOlder
    const hasNewer = updates.hasNewer ?? prev.hasNewer
    const isLoadingOlder = updates.isLoadingOlder ?? updates.isLoadingMore ?? prev.isLoadingOlder
    const isLoadingNewer = updates.isLoadingNewer ?? prev.isLoadingNewer
    let warning = updates.warning !== undefined ? updates.warning : prev.warning
    if (pendingOverflowVisibleCount > 0 && warning === null) {
        warning = PENDING_OVERFLOW_WARNING
    } else if (pendingOverflowVisibleCount === 0 && warning === PENDING_OVERFLOW_WARNING) {
        warning = null
    }
    if (gaps.length > 0 && warning === null) {
        warning = `${MESSAGE_GAP_WARNING_PREFIX} (${gaps.length}). Load history or return to latest to repair it.`
    } else if (gaps.length === 0 && warning?.startsWith(MESSAGE_GAP_WARNING_PREFIX)) {
        warning = null
    }

    return {
        ...prev,
        messages,
        pending,
        pendingVisibleCount,
        pendingOverflow,
        pendingCount,
        knownServerNewestSeq,
        oldestSeq,
        newestSeq,
        ranges,
        gaps,
        hasOlder,
        hasNewer,
        hasMore: hasOlder,
        isLoading: updates.isLoading !== undefined ? updates.isLoading : prev.isLoading,
        isLoadingOlder,
        isLoadingNewer,
        isLoadingMore: isLoadingOlder,
        warning,
        atBottom: updates.atBottom !== undefined ? updates.atBottom : prev.atBottom,
        messagesVersion,
        replacementGeneration: updates.replacementGeneration ?? prev.replacementGeneration,
    }
}

function trimPending(
    sessionId: string,
    messages: DecryptedMessage[]
): { pending: DecryptedMessage[]; dropped: DecryptedMessage[]; droppedVisible: number } {
    // Persisted rows can be recovered by an exact refresh after overflow, but a
    // local-only optimistic row has no other source of truth. Keep unmatched
    // optimistic rows outside the evictable pending-turn capacity until a
    // stored localId echo reconciles them.
    const optimistic = messages.filter(isOptimisticMessage)
    const evictable = messages.filter((message) => !isOptimisticMessage(message))
    const trimmed = trimToCompleteTurns(evictable, PENDING_WINDOW_TURN_LIMIT, 'append')
    const droppedMessages = trimmed.dropped
    const pending = mergeMessages(trimmed.messages, optimistic)
    const droppedVisible = countVisiblePendingMessages(sessionId, droppedMessages)
    return { pending, dropped: droppedMessages, droppedVisible }
}

function filterPendingAgainstVisible(pending: DecryptedMessage[], visible: DecryptedMessage[]): DecryptedMessage[] {
    if (pending.length === 0 || visible.length === 0) {
        return pending
    }
    const visibleIds = new Set(visible.map((message) => message.id))
    const persistedVisibleLocalIds = new Set(visible
        .filter((message) => !isOptimisticMessage(message) && message.localId)
        .map((message) => message.localId as string))
    const filtered = pending.filter((message) => (
        !visibleIds.has(message.id)
        && !(
            isOptimisticMessage(message)
            && message.localId
            && persistedVisibleLocalIds.has(message.localId)
        )
    ))
    return filtered.length === pending.length ? pending : filtered
}

function filterVisibleAgainstPending(visible: DecryptedMessage[], pending: DecryptedMessage[]): DecryptedMessage[] {
    if (visible.length === 0 || pending.length === 0) {
        return visible
    }
    const persistedPendingLocalIds = new Set(pending
        .filter((message) => !isOptimisticMessage(message) && message.localId)
        .map((message) => message.localId as string))
    if (persistedPendingLocalIds.size === 0) {
        return visible
    }
    const filtered = visible.filter((message) => !(
        isOptimisticMessage(message)
        && message.localId
        && persistedPendingLocalIds.has(message.localId)
    ))
    return filtered.length === visible.length ? visible : filtered
}

function reconcileMessagePartitions(
    visible: DecryptedMessage[],
    pending: DecryptedMessage[],
): { messages: DecryptedMessage[]; pending: DecryptedMessage[] } {
    const nextPending = filterPendingAgainstVisible(pending, visible)
    return {
        messages: filterVisibleAgainstPending(visible, nextPending),
        pending: nextPending,
    }
}

function isOptimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function trimVisibleForAppend(messages: DecryptedMessage[]): {
    messages: DecryptedMessage[]
    dropped: DecryptedMessage[]
} {
    const trimmed = trimToCompleteTurns(messages, VISIBLE_WINDOW_TURN_LIMIT, 'append')
    const protectedOptimistic = trimmed.dropped.filter(isOptimisticMessage)
    if (protectedOptimistic.length === 0) {
        return trimmed
    }
    return {
        messages: mergeMessages(trimmed.messages, protectedOptimistic),
        dropped: trimmed.dropped.filter((message) => !isOptimisticMessage(message)),
    }
}

function newestServerSequence(messages: DecryptedMessage[]): number | null {
    let newest: number | null = null
    for (const message of messages) {
        if (isOptimisticMessage(message) || typeof message.seq !== 'number') {
            continue
        }
        if (newest === null || message.seq > newest) {
            newest = message.seq
        }
    }
    return newest
}

function classifyLatestRowsForReview(
    prev: InternalState,
    incoming: DecryptedMessage[],
): DecryptedMessage[] {
    if (incoming.length === 0) {
        return incoming
    }
    const visibleIds = new Set(prev.messages.map((message) => message.id))
    const optimisticLocalIds = new Set([...prev.messages, ...prev.pending]
        .filter(isOptimisticMessage)
        .map((message) => message.localId)
        .filter((localId): localId is string => Boolean(localId)))

    return incoming.filter((message) => {
        if (!isOptimisticMessage(message) && message.localId && optimisticLocalIds.has(message.localId)) {
            return true
        }
        if (typeof message.seq !== 'number') {
            return !visibleIds.has(message.id)
        }
        return prev.knownServerNewestSeq === null || message.seq > prev.knownServerNewestSeq
    })
}

function mergeIntoPending(
    prev: InternalState,
    incoming: DecryptedMessage[],
    visible: DecryptedMessage[] = prev.messages,
): {
    messages: DecryptedMessage[]
    pending: DecryptedMessage[]
    pendingVisibleCount: number
    pendingOverflow: ReadonlyMap<string, boolean>
    warning: string | null
} {
    const mergedPending = incoming.length === 0
        ? prev.pending
        : mergeMessages(prev.pending, incoming)
    const filtered = filterPendingAgainstVisible(mergedPending, visible)
    const { pending, dropped, droppedVisible } = trimPending(prev.sessionId, filtered)
    const messages = filterVisibleAgainstPending(visible, pending)
    const pendingVisibleCount = countVisiblePendingMessages(prev.sessionId, pending)
    const pendingOverflow = new Map(prev.pendingOverflow)
    for (const message of dropped) {
        pendingOverflow.set(message.id, isVisiblePendingMessage(prev.sessionId, message))
    }
    for (const message of [...messages, ...pending]) {
        pendingOverflow.delete(message.id)
    }
    const warning = droppedVisible > 0 && !prev.warning ? PENDING_OVERFLOW_WARNING : prev.warning
    return { messages, pending, pendingVisibleCount, pendingOverflow, warning }
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    clearIdleCleanup(sessionId)
    const subs = listeners.get(sessionId) ?? new Set()
    subs.add(listener)
    listeners.set(sessionId, subs)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
            scheduleIdleCleanup(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    clearIdleCleanup(sessionId)
    clearPendingVisibilityCache(sessionId)
    invalidateMessageWindowRequests(sessionId)
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
    clearIdleCleanup(toSessionId)
    clearPendingVisibilityCache(toSessionId)
    invalidateMessageWindowRequests(toSessionId)
    const base = createState(toSessionId)
    const next = buildState(base, {
        messages: [...source.messages],
        pending: [...source.pending],
        pendingOverflow: new Map(source.pendingOverflow),
        knownServerNewestSeq: source.knownServerNewestSeq,
        hasOlder: source.hasOlder,
        hasNewer: source.hasNewer,
        warning: source.warning,
        atBottom: source.atBottom,
        isLoading: false,
        isLoadingOlder: false,
        isLoadingNewer: false,
    })
    setState(toSessionId, next)
}

async function fetchCompleteDirectionalPage(
    api: ApiClient,
    sessionId: string,
    options: {
        limit: number
        beforeSeq: number | null
        afterSeq: number | null
        markRead?: boolean
    },
    lifecycleEpoch: number,
): Promise<MessagesResponse | null> {
    if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
        return null
    }
    let response = await api.getMessages(sessionId, options)
    if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
        return null
    }
    const originalDirection = response.page.direction
    let continuationCount = 0

    while (response.page.continuation !== null) {
        if (continuationCount >= MAX_PAGE_CONTINUATIONS) {
            throw new Error(`Message page remained incomplete after ${MAX_PAGE_CONTINUATIONS} continuations`)
        }
        continuationCount += 1
        const continuation = response.page.continuation
        if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
            return null
        }
        const next = await api.getMessages(sessionId, {
            limit: options.limit,
            beforeSeq: continuation.direction === 'older' ? continuation.cursorSeq : null,
            afterSeq: continuation.direction === 'newer' ? continuation.cursorSeq : null,
        })
        if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
            return null
        }
        if (continuation.direction === 'older') {
            response = {
                messages: mergeMessages(next.messages, response.messages),
                page: {
                    ...response.page,
                    direction: originalDirection,
                    nextBeforeSeq: next.page.nextBeforeSeq,
                    hasMore: next.page.hasOlder,
                    hasOlder: next.page.hasOlder,
                    range: next.page.range && response.page.range
                        ? {
                            startSeq: next.page.range.startSeq,
                            endSeq: response.page.range.endSeq,
                        }
                        : next.page.range ?? response.page.range,
                    startComplete: next.page.startComplete,
                    continuation: next.page.continuation,
                },
            }
        } else {
            response = {
                messages: mergeMessages(response.messages, next.messages),
                page: {
                    ...response.page,
                    direction: originalDirection,
                    nextAfterSeq: next.page.nextAfterSeq,
                    hasNewer: next.page.hasNewer,
                    range: response.page.range && next.page.range
                        ? {
                            startSeq: response.page.range.startSeq,
                            endSeq: next.page.range.endSeq,
                        }
                        : response.page.range ?? next.page.range,
                    endComplete: next.page.endComplete,
                    continuation: next.page.continuation,
                },
            }
        }
    }
    return response
}

async function performLatestMessagesFetch(
    api: ApiClient,
    sessionId: string,
    options?: LatestFetchOptions,
): Promise<boolean> {
    const lifecycleEpoch = getState(sessionId).lifecycleEpoch
    updateState(sessionId, (prev) => buildState(prev, {
        isLoading: true,
        isLoadingOlder: options?.forceReplace ? false : prev.isLoadingOlder,
        isLoadingNewer: options?.forceReplace ? false : prev.isLoadingNewer,
        warning: null,
        replacementGeneration: options?.forceReplace
            ? nextReplacementGeneration++
            : prev.replacementGeneration,
    }))

    for (let attempt = 1; attempt <= MAX_EXACT_LATEST_STABILIZATION_ATTEMPTS; attempt += 1) {
        const requestStart = getState(sessionId)
        const knownIdsAtRequestStart = new Set(
            [...requestStart.messages, ...requestStart.pending].map((message) => message.id),
        )
        const pendingOverflowAtRequestStart = requestStart.pendingOverflow.size
        const serverWatermarkAtRequestStart = options?.forceReplace
            ? requestStart.knownServerNewestSeq
            : null

        try {
            const response = await fetchCompleteDirectionalPage(api, sessionId, {
                limit: LATEST_PAGE_ROW_TARGET,
                beforeSeq: null,
                afterSeq: null,
                markRead: options?.markRead
            }, lifecycleEpoch)
            if (response === null) {
                return false
            }
            if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
                return false
            }
            let shouldRetryExactLatest = false
            updateState(sessionId, (prev) => {
                const responseEndSeq = response.page.range?.endSeq
                    ?? newestServerSequence(response.messages)
                const responseIsBehindRequestStart = options?.forceReplace
                    && serverWatermarkAtRequestStart !== null
                    && (responseEndSeq === null || responseEndSeq < serverWatermarkAtRequestStart)
                const overflowedDuringRequest = options?.forceReplace
                    && prev.pendingOverflow.size > pendingOverflowAtRequestStart
                if (responseIsBehindRequestStart || overflowedDuringRequest) {
                    shouldRetryExactLatest = true
                    return buildState(prev, {
                        isLoading: true,
                        warning: PENDING_OVERFLOW_WARNING,
                    })
                }

                if (prev.atBottom || options?.forceReplace) {
                    const localTail = options?.forceReplace
                        ? [...prev.messages, ...prev.pending].filter((message) => (
                            isOptimisticMessage(message)
                            || !knownIdsAtRequestStart.has(message.id)
                        ))
                        : [...prev.messages, ...prev.pending].filter((message) => (
                            isOptimisticMessage(message)
                            || !knownIdsAtRequestStart.has(message.id)
                            || (responseEndSeq !== null
                                && typeof message.seq === 'number'
                                && message.seq > responseEndSeq)
                        ))
                    const merged = mergeMessages(response.messages, localTail)
                    const trimmedResult = trimVisibleForAppend(merged)
                    return buildState(prev, {
                        messages: trimmedResult.messages,
                        pending: [],
                        pendingOverflow: new Map(),
                        pendingVisibleCount: 0,
                        hasOlder: response.page.hasOlder || trimmedResult.dropped.length > 0,
                        hasNewer: response.page.hasNewer,
                        isLoading: false,
                        warning: null,
                        atBottom: true,
                        replacementGeneration: options?.forceReplace
                            ? nextReplacementGeneration++
                            : prev.replacementGeneration,
                    })
                }
                const pendingResult = mergeIntoPending(
                    prev,
                    classifyLatestRowsForReview(prev, response.messages),
                )
                return buildState(prev, {
                    messages: pendingResult.messages,
                    pending: pendingResult.pending,
                    pendingVisibleCount: pendingResult.pendingVisibleCount,
                    pendingOverflow: pendingResult.pendingOverflow,
                    isLoading: false,
                    warning: pendingResult.warning,
                })
            })

            if (!shouldRetryExactLatest) {
                return true
            }
            if (attempt === MAX_EXACT_LATEST_STABILIZATION_ATTEMPTS) {
                updateState(sessionId, (prev) => buildState(prev, {
                    isLoading: false,
                    warning: EXACT_LATEST_UNSTABLE_WARNING,
                }))
                return false
            }
        } catch (error) {
            if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
                return false
            }
            const message = error instanceof Error ? error.message : 'Failed to load messages'
            updateState(sessionId, (prev) => buildState(prev, { isLoading: false, warning: message }))
            return false
        }
    }

    return false
}

function startLatestMessagesFetch(
    api: ApiClient,
    sessionId: string,
    options?: LatestFetchOptions,
): Promise<boolean> {
    let trackedFetch!: Promise<boolean>
    trackedFetch = (async () => {
        try {
            return await performLatestMessagesFetch(api, sessionId, options)
        } finally {
            if (latestFetchPromises.get(sessionId) === trackedFetch) {
                latestFetchPromises.delete(sessionId)
            }
        }
    })()
    latestFetchPromises.set(sessionId, trackedFetch)
    return trackedFetch
}

export async function fetchLatestMessages(
    api: ApiClient,
    sessionId: string,
    options?: LatestFetchOptions,
): Promise<boolean> {
    const lifecycleEpoch = getState(sessionId).lifecycleEpoch
    const queuedRevalidation = queuedLatestRevalidationPromises.get(sessionId)
    if (queuedRevalidation && options?.revalidateAfterActive && !options.forceReplace) {
        return await queuedRevalidation
    }

    const activeFetch = latestFetchPromises.get(sessionId)
    if (activeFetch) {
        if (options?.forceReplace) {
            await activeFetch
            if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
                return false
            }
            return await fetchLatestMessages(api, sessionId, options)
        }
        if (options?.revalidateAfterActive) {
            let revalidation!: Promise<boolean>
            revalidation = (async () => {
                try {
                    await activeFetch
                    if (!isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
                        return false
                    }
                    return await fetchLatestMessages(api, sessionId, {
                        markRead: options.markRead,
                    })
                } finally {
                    if (queuedLatestRevalidationPromises.get(sessionId) === revalidation) {
                        queuedLatestRevalidationPromises.delete(sessionId)
                    }
                }
            })()
            queuedLatestRevalidationPromises.set(sessionId, revalidation)
            return await revalidation
        }
        const activeFetchSucceeded = await activeFetch
        if (!activeFetchSucceeded || !isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)) {
            return false
        }
        if (options?.markRead) {
            try {
                await api.markSessionRead(sessionId)
                return isCurrentLifecycleEpoch(sessionId, lifecycleEpoch)
            } catch {
                return false
            }
        }
        return true
    }

    if (getState(sessionId).isLoading) {
        return false
    }

    return await startLatestMessagesFetch(api, sessionId, options)
}

export async function revalidateLatestMessagesAfterSseConnect(
    api: ApiClient,
    sessionId: string,
): Promise<boolean> {
    return await fetchLatestMessages(api, sessionId, { revalidateAfterActive: true })
}

export async function returnToLatestMessages(
    api: ApiClient,
    sessionId: string,
    options?: { markRead?: boolean },
): Promise<boolean> {
    return await fetchLatestMessages(api, sessionId, {
        markRead: options?.markRead,
        forceReplace: true,
    })
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoading || initial.isLoadingOlder || !initial.hasOlder) {
        return
    }
    if (initial.oldestSeq === null) {
        return
    }
    // Directional paging is a user-visible navigation action. Publish it
    // immediately so the thread can capture and restore its reading anchor
    // against the same state transition instead of the streaming throttle.
    updateState(sessionId, (prev) => buildState(prev, { isLoadingOlder: true }), true)

    try {
        const response = await fetchCompleteDirectionalPage(api, sessionId, {
            limit: DIRECTIONAL_PAGE_ROW_TARGET,
            beforeSeq: initial.oldestSeq,
            afterSeq: null,
        }, initial.lifecycleEpoch)
        if (response === null) {
            return
        }
        if (!isCurrentLifecycleEpoch(sessionId, initial.lifecycleEpoch)) {
            return
        }
        updateState(sessionId, (prev) => {
            if (prev.replacementGeneration !== initial.replacementGeneration) {
                return prev
            }
            if (prev.messagesVersion !== initial.messagesVersion) {
                return buildState(prev, { isLoadingOlder: false })
            }
            const merged = mergeMessages(response.messages, prev.messages)
            const trimmed = trimToCompleteTurns(merged, VISIBLE_WINDOW_TURN_LIMIT, 'prepend')
            const pendingResult = mergeIntoPending(
                prev,
                trimmed.dropped.filter(isOptimisticMessage),
                trimmed.messages,
            )
            return buildState(prev, {
                messages: pendingResult.messages,
                pending: pendingResult.pending,
                pendingVisibleCount: pendingResult.pendingVisibleCount,
                pendingOverflow: pendingResult.pendingOverflow,
                hasOlder: response.page.hasOlder,
                hasNewer: prev.hasNewer || trimmed.dropped.length > 0,
                isLoadingOlder: false,
                warning: pendingResult.warning,
            })
        }, true)
    } catch (error) {
        if (!isCurrentLifecycleEpoch(sessionId, initial.lifecycleEpoch)) {
            return
        }
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => {
            if (prev.replacementGeneration !== initial.replacementGeneration) {
                return prev
            }
            return buildState(prev, { isLoadingOlder: false, warning: message })
        }, true)
    }
}

export async function fetchNewerMessages(api: ApiClient, sessionId: string): Promise<void> {
    const initial = getState(sessionId)
    if (initial.isLoading || initial.isLoadingNewer || !initial.hasNewer || initial.newestSeq === null) {
        return
    }
    updateState(sessionId, (prev) => buildState(prev, { isLoadingNewer: true }), true)

    try {
        const response = await fetchCompleteDirectionalPage(api, sessionId, {
            limit: DIRECTIONAL_PAGE_ROW_TARGET,
            beforeSeq: null,
            afterSeq: initial.newestSeq,
        }, initial.lifecycleEpoch)
        if (response === null) {
            return
        }
        if (!isCurrentLifecycleEpoch(sessionId, initial.lifecycleEpoch)) {
            return
        }
        updateState(sessionId, (prev) => {
            if (prev.replacementGeneration !== initial.replacementGeneration) {
                return prev
            }
            if (prev.messagesVersion !== initial.messagesVersion) {
                return buildState(prev, { isLoadingNewer: false })
            }
            const merged = mergeMessages(prev.messages, response.messages)
            const trimmed = trimVisibleForAppend(merged)
            const reconciled = reconcileMessagePartitions(trimmed.messages, prev.pending)
            return buildState(prev, {
                messages: reconciled.messages,
                pending: reconciled.pending,
                hasOlder: prev.hasOlder || trimmed.dropped.length > 0,
                hasNewer: response.page.hasNewer
                    || reconciled.pending.length > 0
                    || prev.pendingOverflow.size > 0,
                isLoadingNewer: false,
            })
        }, true)
    } catch (error) {
        if (!isCurrentLifecycleEpoch(sessionId, initial.lifecycleEpoch)) {
            return
        }
        const message = error instanceof Error ? error.message : 'Failed to load messages'
        updateState(sessionId, (prev) => {
            if (prev.replacementGeneration !== initial.replacementGeneration) {
                return prev
            }
            return buildState(prev, { isLoadingNewer: false, warning: message })
        }, true)
    }
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) {
        return
    }
    updateState(sessionId, (prev) => {
        if (prev.atBottom && !prev.hasNewer) {
            const merged = mergeMessages(prev.messages, incoming)
            const trimmed = trimVisibleForAppend(merged)
            const reconciled = reconcileMessagePartitions(trimmed.messages, prev.pending)
            return buildState(prev, {
                messages: reconciled.messages,
                pending: reconciled.pending,
                hasOlder: prev.hasOlder || trimmed.dropped.length > 0,
            })
        }
        const pendingResult = mergeIntoPending(prev, incoming)
        return buildState(prev, {
            messages: pendingResult.messages,
            pending: pendingResult.pending,
            pendingVisibleCount: pendingResult.pendingVisibleCount,
            pendingOverflow: pendingResult.pendingOverflow,
            warning: pendingResult.warning,
        })
    })
}

export function flushPendingMessages(sessionId: string): boolean {
    const current = getState(sessionId)
    const needsRefresh = Array.from(current.pendingOverflow.values()).some(Boolean)
        || current.hasNewer
        || current.gaps.length > 0
    if (needsRefresh) {
        return true
    }
    if (current.pending.length === 0) {
        return false
    }
    updateState(sessionId, (prev) => {
        const merged = mergeMessages(prev.messages, prev.pending)
        const trimmed = trimVisibleForAppend(merged)
        return buildState(prev, {
            messages: trimmed.messages,
            pending: [],
            pendingOverflow: new Map(),
            pendingVisibleCount: 0,
            hasOlder: prev.hasOlder || trimmed.dropped.length > 0,
            hasNewer: false,
            warning: prev.warning,
        })
    }, true)
    return false
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
        const trimmed = trimVisibleForAppend(merged)
        const reconciled = reconcileMessagePartitions(trimmed.messages, prev.pending)
        return buildState(prev, {
            messages: reconciled.messages,
            pending: reconciled.pending,
            hasOlder: prev.hasOlder || trimmed.dropped.length > 0,
            atBottom: true,
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
                if (message.localId !== localId || !isOptimisticMessage(message)) {
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

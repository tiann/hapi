import { getReasoningStreamId } from '@hapi/protocol/messages'
import type { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'

export type MessageViewMode = 'tail' | 'history'

export type OlderLoadOutcome =
    | {
        kind: 'applied'
        historyVersion: number
        hasMore: boolean
        addedRenderableCount: number
    }
    | {
        kind: 'stopped'
        reason: 'unavailable' | 'busy' | 'invalidated' | 'epoch-reset' | 'exhausted'
    }
    | {
        kind: 'failed'
        error: Error
    }

export type MessageWindowState = {
    sessionId: string
    messages: DecryptedMessage[]
    hasMore: boolean
    oldestSeq: number | null
    newestSeq: number | null
    epoch: number | null
    isSyncingTail: boolean
    isLoadingMore: boolean
    warning: string | null
    viewMode: MessageViewMode
    messagesVersion: number
    historyVersion: number
    tailRevision: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const HISTORY_WINDOW_SIZE = 600
const AGENT_RUN_WINDOW_SIZE = 800
const OLDER_LOAD_WINDOW_SIZE = 800
const PAGE_SIZE = 200

type MessagePosition = {
    at: number
    seq: number
}

type InternalState = MessageWindowState & {
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
    /**
     * Oldest position of the "tail region" after older-history pages were
     * loaded (the cursor of the last successful older-page fetch). Messages
     * strictly older than this boundary are part of the loaded history the
     * user is browsing; tail-mode trims must not evict them while streaming
     * ingests arrive, or the viewport anchored in the loaded range jumps up
     * repeatedly on a running session. Cleared when the window re-enters the
     * tail (enterTailMode) or is rebuilt by a tail resync.
     */
    historyBoundaryAt: number | null
    historyBoundarySeq: number | null
    /**
     * olderGeneration of the in-flight outline request that provisionally
     * installed historyBoundaryAt/Seq at request start. A tail resync or
     * cancel that invalidates that generation must release the boundary too,
     * or the no-trim branch would outlive the load that armed it.
     */
    provisionalBoundaryGeneration: number | null
    requiresLatestReset: boolean
    preferLatestOnActivation: boolean
    syncGeneration: number
    olderGeneration: number
}

type PersistedMessageWindowState = {
    messages: DecryptedMessage[]
    hasMore: boolean
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
    historyBoundaryAt: number | null
    historyBoundarySeq: number | null
    epoch: number | null
}

type TailSyncController = {
    api: ApiClient
    running: Promise<void> | null
    trailingRequested: boolean
    runningPrefersLatest: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const tailSyncControllers = new Map<string, TailSyncController>()

const NOTIFY_THROTTLE_MS = 150
const PERSIST_THROTTLE_MS = 200
const STORAGE_KEY_PREFIX = 'hapi:message-window:v2:'
const pendingNotifySessionIds = new Set<string>()
const pendingPersistSessionIds = new Set<string>()
let notifyRafId: ReturnType<typeof requestAnimationFrame> | null = null
let notifyTimerId: ReturnType<typeof setTimeout> | null = null
let persistTimerId: ReturnType<typeof setTimeout> | null = null
let lastNotifyAt = 0

function requestNotifyFrame(): void {
    if (notifyRafId !== null) {
        return
    }
    if (typeof requestAnimationFrame === 'function') {
        notifyRafId = requestAnimationFrame(flushNotifications)
        return
    }
    notifyRafId = setTimeout(flushNotifications, 0) as unknown as ReturnType<typeof requestAnimationFrame>
}

function scheduleNotify(sessionId: string): void {
    pendingNotifySessionIds.add(sessionId)
    if (notifyRafId !== null || notifyTimerId !== null) {
        return
    }
    const remaining = NOTIFY_THROTTLE_MS - (Date.now() - lastNotifyAt)
    if (remaining <= 0) {
        requestNotifyFrame()
        return
    }
    notifyTimerId = setTimeout(() => {
        notifyTimerId = null
        requestNotifyFrame()
    }, remaining)
}

function flushNotifications(): void {
    notifyRafId = null
    lastNotifyAt = Date.now()
    const sessionIds = [...pendingNotifySessionIds]
    pendingNotifySessionIds.clear()
    for (const sessionId of sessionIds) {
        const subscribers = listeners.get(sessionId)
        if (!subscribers) continue
        for (const listener of subscribers) {
            listener()
        }
    }
}

function getStorageKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionId}`
}

function isSessionStorageAvailable(): boolean {
    try {
        return typeof sessionStorage?.getItem === 'function'
    } catch {
        return false
    }
}

function toNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readPosition(at: unknown, seq: unknown): MessagePosition | null {
    const positionAt = toNullableNumber(at)
    const positionSeq = toNullableNumber(seq)
    return positionAt !== null && positionSeq !== null
        ? { at: positionAt, seq: positionSeq }
        : null
}

function shouldPersistState(state: InternalState): boolean {
    return state.messages.length > 0
        || state.hasMore
        || state.epoch !== null
        || state.oldestPositionAt !== null
        || state.newestPositionAt !== null
        || state.historyBoundaryAt !== null
}

function persistState(sessionId: string, state: InternalState): void {
    if (!isSessionStorageAvailable()) {
        return
    }
    try {
        if (!shouldPersistState(state)) {
            sessionStorage.removeItem(getStorageKey(sessionId))
            return
        }
        const persisted: PersistedMessageWindowState = {
            messages: state.messages,
            hasMore: state.hasMore,
            oldestPositionAt: state.oldestPositionAt,
            oldestPositionSeq: state.oldestPositionSeq,
            newestPositionAt: state.newestPositionAt,
            newestPositionSeq: state.newestPositionSeq,
            historyBoundaryAt: state.historyBoundaryAt,
            historyBoundarySeq: state.historyBoundarySeq,
            epoch: state.epoch
        }
        sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(persisted))
    } catch {
    }
}

function clearPersistedState(sessionId: string): void {
    pendingPersistSessionIds.delete(sessionId)
    if (!isSessionStorageAvailable()) {
        return
    }
    try {
        sessionStorage.removeItem(getStorageKey(sessionId))
    } catch {
    }
}

function flushPersistedStates(): void {
    persistTimerId = null
    const sessionIds = [...pendingPersistSessionIds]
    pendingPersistSessionIds.clear()
    for (const sessionId of sessionIds) {
        const state = states.get(sessionId)
        if (state) {
            persistState(sessionId, state)
        } else {
            clearPersistedState(sessionId)
        }
    }
}

function schedulePersist(sessionId: string): void {
    if (!isSessionStorageAvailable()) {
        return
    }
    pendingPersistSessionIds.add(sessionId)
    if (persistTimerId === null) {
        persistTimerId = setTimeout(flushPersistedStates, PERSIST_THROTTLE_MS)
    }
}

function createState(sessionId: string): InternalState {
    return {
        sessionId,
        messages: [],
        hasMore: false,
        oldestSeq: null,
        newestSeq: null,
        epoch: null,
        isSyncingTail: false,
        isLoadingMore: false,
        warning: null,
        viewMode: 'tail',
        messagesVersion: 0,
        historyVersion: 0,
        tailRevision: 0,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestPositionAt: null,
        newestPositionSeq: null,
        historyBoundaryAt: null,
        historyBoundarySeq: null,
        provisionalBoundaryGeneration: null,
        requiresLatestReset: false,
        preferLatestOnActivation: false,
        syncGeneration: 0,
        olderGeneration: 0
    }
}

function hydrateState(sessionId: string): InternalState | null {
    if (!isSessionStorageAvailable()) {
        return null
    }
    try {
        const raw = sessionStorage.getItem(getStorageKey(sessionId))
        if (!raw) {
            return null
        }
        const parsed = JSON.parse(raw) as Partial<PersistedMessageWindowState> | null
        if (!parsed || !Array.isArray(parsed.messages)) {
            clearPersistedState(sessionId)
            return null
        }
        const restoreMessage = (message: DecryptedMessage): DecryptedMessage => {
            if (message.status !== 'sending') {
                return message
            }
            return {
                ...message,
                status: message.invokedAt === null ? 'queued' : 'sent'
            }
        }
        const oldest = readPosition(parsed.oldestPositionAt, parsed.oldestPositionSeq)
        const newest = readPosition(parsed.newestPositionAt, parsed.newestPositionSeq)
        const historyBoundary = readPosition(parsed.historyBoundaryAt, parsed.historyBoundarySeq)
        const epoch = typeof parsed.epoch === 'number' && Number.isInteger(parsed.epoch) && parsed.epoch >= 0
            ? parsed.epoch
            : null
        return buildState(createState(sessionId), {
            messages: mergeMessages([], parsed.messages.map(restoreMessage)),
            hasMore: parsed.hasMore === true,
            oldestPositionAt: oldest?.at ?? null,
            oldestPositionSeq: oldest?.seq ?? null,
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null,
            historyBoundaryAt: historyBoundary?.at ?? null,
            historyBoundarySeq: historyBoundary?.seq ?? null,
            epoch,
            requiresLatestReset: parsed.messages.length > 0 && (newest === null || epoch === null)
        })
    } catch {
        clearPersistedState(sessionId)
        return null
    }
}

function getState(sessionId: string): InternalState {
    const existing = states.get(sessionId)
    if (existing) {
        return existing
    }
    const created = hydrateState(sessionId) ?? createState(sessionId)
    states.set(sessionId, created)
    return created
}

function notifyImmediate(sessionId: string): void {
    const subscribers = listeners.get(sessionId)
    if (!subscribers) return
    for (const listener of subscribers) {
        listener()
    }
}

function setState(sessionId: string, next: InternalState, immediate = false): void {
    states.set(sessionId, next)
    schedulePersist(sessionId)
    if (immediate) {
        notifyImmediate(sessionId)
    } else {
        scheduleNotify(sessionId)
    }
}

function updateState(
    sessionId: string,
    updater: (previous: InternalState) => InternalState,
    immediate = false
): void {
    const previous = getState(sessionId)
    const next = updater(previous)
    if (next !== previous) {
        setState(sessionId, next, immediate)
    }
}

function deriveSeqBounds(messages: DecryptedMessage[]): { oldestSeq: number | null; newestSeq: number | null } {
    let oldestSeq: number | null = null
    let newestSeq: number | null = null
    for (const message of messages) {
        if (typeof message.seq !== 'number') continue
        oldestSeq = oldestSeq === null ? message.seq : Math.min(oldestSeq, message.seq)
        newestSeq = newestSeq === null ? message.seq : Math.max(newestSeq, message.seq)
    }
    return { oldestSeq, newestSeq }
}

function messagePosition(message: DecryptedMessage): MessagePosition | null {
    return typeof message.seq === 'number'
        ? { at: message.invokedAt ?? message.createdAt, seq: message.seq }
        : null
}

function comparePosition(left: MessagePosition, right: MessagePosition): number {
    return left.at !== right.at ? left.at - right.at : left.seq - right.seq
}

function derivePosition(
    messages: DecryptedMessage[],
    direction: 'oldest' | 'newest'
): MessagePosition | null {
    let selected: MessagePosition | null = null
    for (const message of messages) {
        const candidate = messagePosition(message)
        if (!candidate) continue
        if (!selected) {
            selected = candidate
            continue
        }
        const comparison = comparePosition(candidate, selected)
        if ((direction === 'oldest' && comparison < 0) || (direction === 'newest' && comparison > 0)) {
            selected = candidate
        }
    }
    return selected
}

function getNewestCursor(state: InternalState): MessagePosition | null {
    return readPosition(state.newestPositionAt, state.newestPositionSeq)
}

function buildState(
    previous: InternalState,
    updates: Partial<Pick<InternalState,
        | 'messages'
        | 'hasMore'
        | 'epoch'
        | 'isSyncingTail'
        | 'isLoadingMore'
        | 'warning'
        | 'viewMode'
        | 'oldestPositionAt'
        | 'oldestPositionSeq'
        | 'newestPositionAt'
        | 'newestPositionSeq'
        | 'historyBoundaryAt'
        | 'historyBoundarySeq'
        | 'provisionalBoundaryGeneration'
        | 'requiresLatestReset'
        | 'preferLatestOnActivation'
        | 'syncGeneration'
        | 'olderGeneration'
        | 'historyVersion'
        | 'tailRevision'
    >>
): InternalState {
    const messages = updates.messages ?? previous.messages
    const bounds = deriveSeqBounds(messages)
    return {
        ...previous,
        ...updates,
        messages,
        oldestSeq: bounds.oldestSeq,
        newestSeq: bounds.newestSeq,
        messagesVersion: messages === previous.messages
            ? previous.messagesVersion
            : previous.messagesVersion + 1
    }
}

function sliceForTrim<T>(
    items: T[],
    limit: number,
    mode: 'append' | 'prepend'
): { kept: T[]; dropped: T[] } {
    if (items.length <= limit) {
        return { kept: items, dropped: [] }
    }
    if (limit <= 0) {
        return { kept: [], dropped: items }
    }
    return mode === 'prepend'
        ? { kept: items.slice(0, limit), dropped: items.slice(limit) }
        : { kept: items.slice(items.length - limit), dropped: items.slice(0, items.length - limit) }
}

function isCodexAgentRunMessage(message: DecryptedMessage): boolean {
    const outer = message.content
    if (!outer || typeof outer !== 'object' || (outer as { role?: unknown }).role !== 'agent') {
        return false
    }
    const content = (outer as { content?: unknown }).content
    if (!content || typeof content !== 'object') return false
    const payload = content as { type?: unknown; data?: unknown }
    if (payload.type !== 'codex' || !payload.data || typeof payload.data !== 'object') {
        return false
    }
    const type = (payload.data as { type?: unknown }).type
    return type === 'agent-run-start' || type === 'agent-run-update' || type === 'agent-run-trace'
}

/** Collapse a reasoning stream down to the one snapshot that still says
 *  something.
 *
 *  The CLI re-sends a growing reasoning buffer under a stable stream id every
 *  few hundred milliseconds, and the timeline already folds those snapshots
 *  into a single block by that id. Sessions recorded before the hub started
 *  retiring them still carry every intermediate, and spending window budget on
 *  rows that render as one block is what pushes the surrounding conversation
 *  out of reach. Messages with no stream id are left alone. */
function dropSupersededReasoningSnapshots(messages: DecryptedMessage[]): DecryptedMessage[] {
    const newestByStream = new Map<string, DecryptedMessage>()
    for (const message of messages) {
        const streamId = getReasoningStreamId(message.content)
        if (streamId === null) continue
        const incumbent = newestByStream.get(streamId)
        if (!incumbent) {
            newestByStream.set(streamId, message)
            continue
        }
        // Fall back to arrival order when either row predates seq numbering:
        // `messages` is kept in display order, so later still means newer.
        const challengerAt = messagePosition(message)
        const incumbentAt = messagePosition(incumbent)
        const newer = challengerAt && incumbentAt
            ? comparePosition(challengerAt, incumbentAt) >= 0
            : true
        if (newer) newestByStream.set(streamId, message)
    }
    if (newestByStream.size === 0) return messages

    const survivors = new Set<string>()
    for (const message of newestByStream.values()) survivors.add(message.id)
    return messages.filter((message) =>
        getReasoningStreamId(message.content) === null || survivors.has(message.id))
}

function trimPreservingQueued(
    incoming: DecryptedMessage[],
    regularLimit: number,
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
    const messages = dropSupersededReasoningSnapshots(incoming)
    const queued = messages.filter(isQueuedForInvocation)
    const queuedIds = new Set(queued.map((message) => message.id))
    const nonQueued = messages.filter((message) => !queuedIds.has(message.id))
    const agentRuns = nonQueued.filter(isCodexAgentRunMessage)
    const regular = nonQueued.filter((message) => !isCodexAgentRunMessage(message))
    const regularTrim = sliceForTrim(regular, Math.max(0, regularLimit - queued.length), mode)
    const agentRunTrim = sliceForTrim(agentRuns, AGENT_RUN_WINDOW_SIZE, mode)
    return {
        kept: mergeMessages([...regularTrim.kept, ...agentRunTrim.kept], queued),
        dropped: [...regularTrim.dropped, ...agentRunTrim.dropped]
    }
}

function optimisticMessage(message: DecryptedMessage): boolean {
    return Boolean(message.localId && message.id === message.localId)
}

function shouldRetainWindowMessage(message: DecryptedMessage): boolean {
    return isQueuedForInvocation(message) || normalizeDecryptedMessage(message) !== null
}

function countNewRenderableMessages(
    previous: InternalState,
    incoming: DecryptedMessage[]
): number {
    const representedIds = new Set(previous.messages.map((message) => message.id))
    const representedLocalIds = new Set(
        previous.messages.flatMap((message) => message.localId ? [message.localId] : [])
    )
    let count = 0
    for (const message of incoming) {
        if (!shouldRetainWindowMessage(message)) continue
        if (representedIds.has(message.id)) continue
        if (message.localId && representedLocalIds.has(message.localId)) continue
        count += 1
        representedIds.add(message.id)
        if (message.localId) representedLocalIds.add(message.localId)
    }
    return count
}

function mergeIntoWindow(
    previous: InternalState,
    incoming: DecryptedMessage[],
    options: {
        mode?: 'append' | 'prepend'
        regularLimit?: number
        historyBoundaryAt?: number | null
        historyBoundarySeq?: number | null
        advanceTailRevision?: boolean
    } = {}
): InternalState {
    const retainedIncoming = incoming.filter(shouldRetainWindowMessage)
    if (retainedIncoming.length === 0) {
        return previous
    }
    const mode = options.mode ?? (previous.viewMode === 'history' ? 'prepend' : 'append')
    const regularLimit = options.regularLimit
        ?? (previous.viewMode === 'history' ? HISTORY_WINDOW_SIZE : VISIBLE_WINDOW_SIZE)
    const merged = mergeMessages(previous.messages, retainedIncoming)

    const boundaryAt = options.historyBoundaryAt !== undefined
        ? options.historyBoundaryAt
        : previous.historyBoundaryAt
    const boundarySeq = options.historyBoundarySeq !== undefined
        ? options.historyBoundarySeq
        : previous.historyBoundarySeq
    const boundary = boundaryAt !== null && boundarySeq !== null
        ? { at: boundaryAt, seq: boundarySeq }
        : null

    let kept: DecryptedMessage[]
    let dropped: DecryptedMessage[]
    let droppedNewest = false
    if (boundary) {
        // Loaded older history is present and the user is browsing it.
        // Tail mode deliberately does NOT trim while the boundary is held:
        // the loaded range must stay readable and the live tail must keep
        // streaming — dropping either side would make the viewport jump or
        // freeze new messages. Releasing the boundary (returning to the tail
        // via enterTailMode, or a tail resync) restores the bounded window.
        // History mode keeps the loaded range whole and caps the tail by
        // dropping its NEWEST rows (reachable through the requiresLatestReset
        // tail resync), so the kept window stays contiguous and the loaded
        // range is never evicted.
        const totalCap = Math.max(regularLimit, OLDER_LOAD_WINDOW_SIZE)
        if (mode === 'append') {
            kept = merged
            dropped = []
        } else {
            const queued = merged.filter(isQueuedForInvocation)
            const queuedIds = new Set(queued.map((message) => message.id))
            const trimmable = merged.filter((message) => !queuedIds.has(message.id))
            const loaded: DecryptedMessage[] = []
            const tail: DecryptedMessage[] = []
            for (const message of trimmable) {
                const position = messagePosition(message)
                if (!position) {
                    loaded.push(message)
                    continue
                }
                if (comparePosition(position, boundary) < 0) {
                    loaded.push(message)
                } else {
                    tail.push(message)
                }
            }
            const loadedTrim = sliceForTrim(loaded, totalCap, 'prepend')
            const tailTrim = sliceForTrim(tail, Math.max(0, totalCap - loadedTrim.kept.length), 'prepend')
            kept = mergeMessages([...loadedTrim.kept, ...tailTrim.kept], queued)
            const keptIds = new Set(kept.map((message) => message.id))
            dropped = merged.filter((message) => !keptIds.has(message.id))
            if (dropped.length > 0) {
                const droppedNewestPosition = derivePosition(dropped, 'newest')
                const mergedNewestPosition = derivePosition(merged, 'newest')
                droppedNewest = droppedNewestPosition !== null
                    && mergedNewestPosition !== null
                    && comparePosition(droppedNewestPosition, mergedNewestPosition) === 0
            }
        }
    } else {
        const trimmed = trimPreservingQueued(merged, regularLimit, mode)
        kept = trimmed.kept
        dropped = trimmed.dropped
        droppedNewest = mode === 'prepend' && dropped.length > 0
    }
    let next = buildState(previous, {
        messages: kept,
        ...(options.advanceTailRevision
            ? { tailRevision: previous.tailRevision + 1 }
            : {})
    })
    if (dropped.length === 0) {
        return next
    }
    if (droppedNewest) {
        const newest = derivePosition(kept, 'newest')
        next = buildState(next, {
            requiresLatestReset: true,
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null
        })
        return next
    }
    const oldest = derivePosition(kept, 'oldest')
    return buildState(next, {
        hasMore: true,
        oldestPositionAt: oldest?.at ?? next.oldestPositionAt,
        oldestPositionSeq: oldest?.seq ?? next.oldestPositionSeq
    })
}

// Rows accumulated while a provisional boundary held the no-trim branch have
// no loaded page to justify them once the boundary is released; trim them with
// the active view's existing window policy immediately.
function trimReleasedProvisionalWindow(previous: InternalState): InternalState {
    const historyMode = previous.viewMode === 'history'
    const { kept, dropped } = trimPreservingQueued(
        previous.messages,
        historyMode ? HISTORY_WINDOW_SIZE : VISIBLE_WINDOW_SIZE,
        historyMode ? 'prepend' : 'append'
    )
    if (dropped.length === 0) {
        return previous
    }
    if (historyMode) {
        const newest = derivePosition(kept, 'newest')
        return buildState(previous, {
            messages: kept,
            requiresLatestReset: true,
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null
        })
    }
    const oldest = derivePosition(kept, 'oldest')
    return buildState(previous, {
        messages: kept,
        hasMore: true,
        oldestPositionAt: oldest?.at ?? previous.oldestPositionAt,
        oldestPositionSeq: oldest?.seq ?? previous.oldestPositionSeq
    })
}

function pagePosition(at: number | null, seq: number | null): MessagePosition | null {
    return at !== null && seq !== null ? { at, seq } : null
}

function applyLatestResponse(
    previous: InternalState,
    response: MessagesResponse,
    options: {
        replaceServerRows: boolean
        requestBaseline: Map<string, DecryptedMessage>
    }
): InternalState {
    const retainedResponseMessages = response.messages.filter(shouldRetainWindowMessage)
    const concurrentServerRows = previous.messages.filter((message) => (
        !optimisticMessage(message)
        && options.requestBaseline.get(message.id) !== message
    ))
    const preserved = options.replaceServerRows
        ? previous.messages.filter((message) => (
            optimisticMessage(message)
            || options.requestBaseline.get(message.id) !== message
        ))
        : previous.messages
    const authoritative = mergeMessages(preserved, retainedResponseMessages)
    const incoming = mergeMessages(authoritative, concurrentServerRows)
    const { kept, dropped } = trimPreservingQueued(incoming, VISIBLE_WINDOW_SIZE, 'append')
    const snapshotHead = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
        ?? derivePosition(response.messages, 'newest')
    const newestKept = derivePosition(kept, 'newest')
    const newest = snapshotHead && newestKept
        ? (comparePosition(snapshotHead, newestKept) >= 0 ? snapshotHead : newestKept)
        : snapshotHead ?? newestKept
    const responseOldest = pagePosition(response.page.nextBeforeAt, response.page.nextBeforeSeq)
    const previousOldest = readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    const oldest = dropped.length > 0
        ? derivePosition(kept, 'oldest')
        : options.replaceServerRows
            ? responseOldest
            : responseOldest ?? previousOldest
    return buildState(previous, {
        messages: kept,
        hasMore: response.page.hasMore || (!options.replaceServerRows && previous.hasMore) || dropped.length > 0,
        epoch: response.page.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: newest?.at ?? null,
        newestPositionSeq: newest?.seq ?? null,
        tailRevision: previous.tailRevision + 1,
        requiresLatestReset: false,
        isLoadingMore: options.replaceServerRows ? false : previous.isLoadingMore,
        olderGeneration: options.replaceServerRows
            ? previous.olderGeneration + 1
            : previous.olderGeneration,
        // A tail resync rebuilds the window from the server's authoritative
        // rows; the loaded-history protection no longer applies.
        historyBoundaryAt: options.replaceServerRows ? null : previous.historyBoundaryAt,
        historyBoundarySeq: options.replaceServerRows ? null : previous.historyBoundarySeq,
        provisionalBoundaryGeneration: options.replaceServerRows
            ? null
            : previous.provisionalBoundaryGeneration,
        warning: null
    })
}

function beginTailSync(sessionId: string): number {
    let generation = 0
    updateState(sessionId, (previous) => {
        generation = previous.syncGeneration + 1
        // Bumping olderGeneration invalidates any in-flight older-page request.
        // If that request provisionally installed the history boundary, the
        // load is gone — release the boundary too, or the no-trim branch would
        // outlive it and the window would grow without limit.
        const releaseProvisional = previous.provisionalBoundaryGeneration !== null
            && previous.provisionalBoundaryGeneration === previous.olderGeneration
        const cleared = buildState(previous, {
            syncGeneration: generation,
            // Tail reconciliation owns the authoritative epoch. An older-page
            // response captured before this point must not commit while the tail
            // request is in flight, or a reset can mistake it for concurrent SSE.
            olderGeneration: previous.olderGeneration + 1,
            isSyncingTail: true,
            isLoadingMore: false,
            warning: null,
            historyBoundaryAt: releaseProvisional ? null : previous.historyBoundaryAt,
            historyBoundarySeq: releaseProvisional ? null : previous.historyBoundarySeq,
            provisionalBoundaryGeneration: releaseProvisional ? null : previous.provisionalBoundaryGeneration
        })
        // Shed the rows the no-trim branch accumulated while the provisional
        // boundary was held, immediately rather than on the next ingest.
        return releaseProvisional ? trimReleasedProvisionalWindow(cleared) : cleared
    })
    return generation
}

function isCurrentTailSync(sessionId: string, generation: number): boolean {
    return getState(sessionId).syncGeneration === generation
}

function finishTailSync(sessionId: string, generation: number, warning: string | null): void {
    updateState(sessionId, (previous) => {
        if (previous.syncGeneration !== generation) {
            return previous
        }
        return buildState(previous, { isSyncingTail: false, warning })
    })
}

async function runTailSync(api: ApiClient, sessionId: string): Promise<void> {
    const generation = beginTailSync(sessionId)
    try {
        const initial = getState(sessionId)
        const initialCursor = getNewestCursor(initial)
        const preferLatestOnActivation = initial.preferLatestOnActivation
        const canIncrement = initialCursor !== null
            && initial.epoch !== null
            && !initial.requiresLatestReset
            && !preferLatestOnActivation

        if (!canIncrement) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            const response = await api.getMessages(sessionId, { limit: PAGE_SIZE })
            if (!isCurrentTailSync(sessionId, generation)) return
            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                const next = applyLatestResponse(previous, response, {
                    replaceServerRows: initial.requiresLatestReset
                        || preferLatestOnActivation
                        || response.page.reset,
                    requestBaseline
                })
                return buildState(next, { preferLatestOnActivation: false })
            })
            finishTailSync(sessionId, generation, null)
            return
        }

        let after = initialCursor
        let until: MessagePosition | null = null
        while (true) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            const response = await api.getMessages(sessionId, {
                afterAt: after.at,
                afterSeq: after.seq,
                untilAt: until?.at ?? null,
                untilSeq: until?.seq ?? null,
                epoch: initial.epoch,
                limit: PAGE_SIZE
            })
            if (!isCurrentTailSync(sessionId, generation)) return

            if (response.page.reset || response.page.direction === 'latest') {
                updateState(sessionId, (previous) => {
                    if (previous.syncGeneration !== generation) return previous
                    return applyLatestResponse(previous, response, {
                        replaceServerRows: true,
                        requestBaseline
                    })
                })
                break
            }

            const nextAfter = pagePosition(response.page.nextAfterAt, response.page.nextAfterSeq)
            const snapshotHead = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
            if (until === null) {
                until = snapshotHead
            }

            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                const merged = mergeIntoWindow(previous, response.messages, {
                    advanceTailRevision: true
                })
                if (merged.requiresLatestReset) {
                    return buildState(merged, {
                        epoch: response.page.epoch,
                        warning: null
                    })
                }
                const currentNewest = getNewestCursor(merged)
                const newest = nextAfter && currentNewest
                    ? (comparePosition(nextAfter, currentNewest) >= 0 ? nextAfter : currentNewest)
                    : nextAfter ?? currentNewest
                return buildState(merged, {
                    epoch: response.page.epoch,
                    newestPositionAt: newest?.at ?? null,
                    newestPositionSeq: newest?.seq ?? null,
                    warning: null
                })
            })

            const current = getState(sessionId)
            if (
                current.requiresLatestReset
                || current.preferLatestOnActivation
                || !response.page.hasMore
                || !nextAfter
            ) {
                break
            }
            if (comparePosition(nextAfter, after) <= 0) {
                throw new Error('Message tail cursor did not advance')
            }
            after = nextAfter
        }

        finishTailSync(sessionId, generation, null)
    } catch (error) {
        if (!isCurrentTailSync(sessionId, generation)) return
        finishTailSync(
            sessionId,
            generation,
            error instanceof Error ? error.message : 'Failed to synchronize messages'
        )
    }
}

function startTailSync(sessionId: string, controller: TailSyncController): Promise<void> {
    const runningPrefersLatest = getState(sessionId).preferLatestOnActivation
    const running = runTailSync(controller.api, sessionId)
    controller.running = running
    controller.runningPrefersLatest = runningPrefersLatest
    const finish = () => {
        if (tailSyncControllers.get(sessionId) !== controller || controller.running !== running) {
            return
        }
        controller.running = null
        controller.runningPrefersLatest = false
        if (!controller.trailingRequested) {
            return
        }
        controller.trailingRequested = false
        startTailSync(sessionId, controller)
    }
    void running.then(finish, finish)
    return running
}

async function waitForTailSyncDrain(
    sessionId: string,
    controller: TailSyncController,
    observed: Promise<void>
): Promise<void> {
    await observed
    if (tailSyncControllers.get(sessionId) !== controller) {
        return
    }
    const current = controller.running
    if (current && current !== observed) {
        await waitForTailSyncDrain(sessionId, controller, current)
    }
}

function enterTailMode(previous: InternalState): InternalState {
    const { kept, dropped } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
    const forceLatest = previous.requiresLatestReset
    const oldest = dropped.length > 0
        ? derivePosition(kept, 'oldest')
        : readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    // Shedding rows while an older-page request is in flight can evict its
    // `before` cursor row (the window's oldest at request start); invalidate
    // that request so its apply cannot re-arm a stale cursor past the gap.
    const invalidateInFlight = previous.isLoadingMore && dropped.length > 0
    return buildState(previous, {
        messages: kept,
        hasMore: previous.hasMore || dropped.length > 0,
        viewMode: 'tail',
        epoch: forceLatest ? null : previous.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: forceLatest ? null : previous.newestPositionAt,
        newestPositionSeq: forceLatest ? null : previous.newestPositionSeq,
        // Returning to the tail releases the loaded-history protection: the
        // window is allowed to shed the older range again (invisibly, the
        // user is at the bottom).
        historyBoundaryAt: null,
        historyBoundarySeq: null,
        provisionalBoundaryGeneration: null,
        olderGeneration: invalidateInFlight ? previous.olderGeneration + 1 : previous.olderGeneration,
        isLoadingMore: invalidateInFlight ? false : previous.isLoadingMore
    })
}

export function activateMessageWindow(sessionId: string): void {
    let requestedLatest = false
    updateState(sessionId, (previous) => {
        const { kept } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
        const forceLatest = previous.requiresLatestReset
        const hasUsableCursor = getNewestCursor(previous) !== null
            && previous.epoch !== null
            && !forceLatest
        const preferLatestOnActivation = hasUsableCursor && kept.length > 0
        requestedLatest = preferLatestOnActivation && !previous.preferLatestOnActivation
        const invalidateRunningSync = requestedLatest && previous.isSyncingTail
        const activationUpdates = preferLatestOnActivation
            ? {
                preferLatestOnActivation: true,
                ...(invalidateRunningSync
                    ? {
                        syncGeneration: previous.syncGeneration + 1,
                        olderGeneration: previous.olderGeneration + 1
                    }
                    : {})
            }
            : {}
        // A persisted cursor may be many pages behind after another client
        // has added messages. Fetch the current tail first on re-entry;
        // `runTailSync` will reconcile the response through the same
        // optimistic/concurrent-row preservation path as a reset response.
        if (
            previous.viewMode === 'tail'
            && kept.length === previous.messages.length
            && !forceLatest
            // A boundary persisted from a previous page session must not
            // survive: the outline that held it is gone, so the window has
            // no release path and would grow unboundedly on SSE ingests.
            && previous.historyBoundaryAt === null
        ) {
            return preferLatestOnActivation
                ? buildState(previous, activationUpdates)
                : previous
        }
        const next = enterTailMode(previous)
        return preferLatestOnActivation
            ? buildState(next, activationUpdates)
            : next
    }, true)
    if (requestedLatest) {
        const controller = tailSyncControllers.get(sessionId)
        if (controller?.running) {
            controller.trailingRequested = true
        }
    }
}

export function syncTailMessages(
    api: ApiClient,
    sessionId: string,
    options: { ensureAfterCurrent?: boolean } = {}
): Promise<void> {
    let controller = tailSyncControllers.get(sessionId)
    if (!controller) {
        controller = {
            api,
            running: null,
            trailingRequested: false,
            runningPrefersLatest: false
        }
        tailSyncControllers.set(sessionId, controller)
    }
    controller.api = api
    if (!controller.running) {
        return startTailSync(sessionId, controller)
    }
    if (getState(sessionId).preferLatestOnActivation) {
        if (controller.runningPrefersLatest) {
            return controller.running
        }
        controller.trailingRequested = false
        return startTailSync(sessionId, controller)
    }
    const observed = controller.running
    if (!options.ensureAfterCurrent) {
        return observed
    }
    controller.trailingRequested = true
    return waitForTailSyncDrain(sessionId, controller, observed)
}

export async function fetchOlderMessages(
    api: ApiClient,
    sessionId: string,
    options: {
        onBeforeApply?: (historyVersion: number) => boolean
        /**
         * Live predicate evaluated when the older page APPLIES (not when the
         * request starts): when it returns true, the loaded-history boundary
         * (tail-mode no-trim protection) is installed for this load. Only
         * user-initiated outline browsing passes it — automatic coverage
         * loads and tool-group hydration must not leave the window unbounded,
         * and history-mode loads are already protected by the oldest-kept
         * trim. Evaluating at apply time also covers an outline closed while
         * a slow request was in flight.
         */
        shouldInstallBoundary?: () => boolean
    } = {}
): Promise<OlderLoadOutcome> {
    const installBoundary = options.shouldInstallBoundary?.() === true
    const initial = getState(sessionId)
    const before = readPosition(initial.oldestPositionAt, initial.oldestPositionSeq)
    if (initial.isSyncingTail || initial.isLoadingMore) {
        return { kind: 'stopped', reason: 'busy' }
    }
    if (!initial.hasMore) {
        return { kind: 'stopped', reason: 'exhausted' }
    }
    if (!before) {
        return { kind: 'stopped', reason: 'unavailable' }
    }
    const generation = initial.olderGeneration + 1
    updateState(sessionId, (previous) => buildState(previous, {
        olderGeneration: generation,
        isLoadingMore: true,
        warning: null
    }))
    // Install the boundary at REQUEST START, not when the response applies:
    // while the request is in flight, SSE ingests keep trimming the tail and
    // could evict the exclusive `before` cursor row (the window's oldest).
    // Applying the older page afterwards would leave a permanent unreachable
    // gap between the page and the trimmed window. Track when WE installed it
    // (no pre-existing boundary) so the rejection/error exits can restore the
    // bounded window if the load never completes.
    const installedProvisionalBoundary = installBoundary && initial.historyBoundaryAt === null
    if (installedProvisionalBoundary) {
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            return buildState(previous, {
                historyBoundaryAt: before.at,
                historyBoundarySeq: before.seq,
                provisionalBoundaryGeneration: generation
            })
        })
    }

    try {
        const response = await api.getMessages(sessionId, {
            beforeAt: before.at,
            beforeSeq: before.seq,
            limit: PAGE_SIZE
        })
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }

        if (initial.epoch !== null && response.page.epoch !== initial.epoch) {
            updateState(sessionId, (previous) => {
                if (previous.olderGeneration !== generation) return previous
                return buildState(previous, {
                    isLoadingMore: false,
                    epoch: null,
                    newestPositionAt: null,
                    newestPositionSeq: null,
                    requiresLatestReset: true
                })
            })
            await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
            return { kind: 'stopped', reason: 'epoch-reset' }
        }

        let historyVersion = 0
        let addedRenderableCount = 0
        let applyRejected = false
        // Prepend trimming and its prepared scroll restore must reach the UI
        // in one publication; the normal 150ms notification throttle would
        // expose rows that this state has already evicted.
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            addedRenderableCount = countNewRenderableMessages(previous, response.messages)
            const nextHistoryVersion = previous.historyVersion + 1
            if (options.onBeforeApply && !options.onBeforeApply(nextHistoryVersion)) {
                applyRejected = true
                // A rejected apply never delivers the loaded page; restore the
                // bounded window if we provisionally installed the boundary,
                // and shed the rows the no-trim branch accumulated.
                const cleared = buildState(previous, {
                    olderGeneration: previous.olderGeneration + 1,
                    isLoadingMore: false,
                    warning: null,
                    historyBoundaryAt: installedProvisionalBoundary ? null : previous.historyBoundaryAt,
                    historyBoundarySeq: installedProvisionalBoundary ? null : previous.historyBoundarySeq,
                    provisionalBoundaryGeneration: installedProvisionalBoundary
                        ? null
                        : previous.provisionalBoundaryGeneration
                })
                return installedProvisionalBoundary ? trimReleasedProvisionalWindow(cleared) : cleared
            }
            const installBoundaryNow = options.shouldInstallBoundary?.() === true
            const compactedOnClose = !installBoundaryNow && installedProvisionalBoundary && previous.viewMode === 'tail'
            let merged = mergeIntoWindow(previous, response.messages, {
                // In history mode keep the oldest side (the loaded pages the
                // user is browsing); in tail mode keep the whole window while
                // the history boundary is held so the live tail keeps streaming.
                mode: previous.viewMode === 'history' ? 'prepend' : 'append',
                regularLimit: OLDER_LOAD_WINDOW_SIZE,
                historyBoundaryAt: previous.historyBoundaryAt ?? (installBoundaryNow ? before.at : undefined),
                historyBoundarySeq: previous.historyBoundarySeq ?? (installBoundaryNow ? before.seq : undefined)
            })
            let oldestPositionAt: number | null = response.page.nextBeforeAt
            let oldestPositionSeq: number | null = response.page.nextBeforeSeq
            if (compactedOnClose) {
                // The outline closed while the request was in flight: the
                // boundary dies with the apply, and in tail mode the rows
                // accumulated by the no-trim branch are shed back to the
                // bounded tail window. In history mode the user is reading
                // the loaded range — the oldest-kept trim protects it and the
                // next ingest sheds only the tail overflow.
                const trimmed = trimReleasedProvisionalWindow(merged)
                if (trimmed !== merged) {
                    // Rows were shed from the oldest end: the pagination
                    // cursor must bookend the compacted window, not the
                    // response's nextBefore (which would point into the gap).
                    oldestPositionAt = trimmed.oldestPositionAt
                    oldestPositionSeq = trimmed.oldestPositionSeq
                }
                merged = trimmed
            }
            historyVersion = nextHistoryVersion
            return buildState(merged, {
                hasMore: response.page.hasMore,
                epoch: response.page.epoch,
                oldestPositionAt,
                oldestPositionSeq,
                // The boundary was installed at request start; carry it past
                // the apply only while the outline is still open. If it
                // closed while the request was in flight, drop the boundary
                // here so the window returns to the bounded tail trim.
                historyBoundaryAt: installBoundaryNow
                    ? before.at
                    : installBoundary
                        ? null
                        : previous.historyBoundaryAt,
                historyBoundarySeq: installBoundaryNow
                    ? before.seq
                    : installBoundary
                        ? null
                        : previous.historyBoundarySeq,
                // The boundary is now held by the outline lifecycle, not by
                // this request; the provisional ownership ends here.
                provisionalBoundaryGeneration: null,
                isLoadingMore: false,
                historyVersion,
                warning: null
            })
        }, true)
        if (applyRejected || historyVersion === 0) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        return {
            kind: 'applied',
            historyVersion,
            hasMore: response.page.hasMore,
            addedRenderableCount
        }
    } catch (error) {
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        const loadError = error instanceof Error
            ? error
            : new Error('Failed to load older messages')
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            // A failed request never delivers the loaded page; restore the
            // bounded window if we provisionally installed the boundary, and
            // shed the rows the no-trim branch accumulated while it was held.
            if (!installedProvisionalBoundary) {
                return buildState(previous, {
                    isLoadingMore: false,
                    warning: loadError.message
                })
            }
            return trimReleasedProvisionalWindow(buildState(previous, {
                isLoadingMore: false,
                warning: loadError.message,
                historyBoundaryAt: null,
                historyBoundarySeq: null,
                provisionalBoundaryGeneration: null
            }))
        })
        return { kind: 'failed', error: loadError }
    }
}

export function cancelOlderMessageLoad(sessionId: string): void {
    updateState(sessionId, (previous) => {
        if (!previous.isLoadingMore) {
            return previous
        }
        const releaseProvisional = previous.provisionalBoundaryGeneration !== null
            && previous.provisionalBoundaryGeneration === previous.olderGeneration
        const cleared = buildState(previous, {
            olderGeneration: previous.olderGeneration + 1,
            isLoadingMore: false,
            warning: null,
            historyBoundaryAt: releaseProvisional ? null : previous.historyBoundaryAt,
            historyBoundarySeq: releaseProvisional ? null : previous.historyBoundarySeq,
            provisionalBoundaryGeneration: releaseProvisional ? null : previous.provisionalBoundaryGeneration
        })
        return releaseProvisional ? trimReleasedProvisionalWindow(cleared) : cleared
    }, true)
}

export function setMessageViewMode(sessionId: string, mode: MessageViewMode): void {
    updateState(sessionId, (previous) => {
        if (previous.viewMode === mode) {
            // Re-asserting tail mode while loaded history is held releases it:
            // the user has returned to the live tail (e.g. the conversation
            // outline closed after a "Load earlier" click), so the window can
            // shed the older range again and stay bounded.
            return mode === 'tail' && previous.historyBoundaryAt !== null
                ? enterTailMode(previous)
                : previous
        }
        if (mode === 'history') {
            return buildState(previous, { viewMode: 'history' })
        }
        return enterTailMode(previous)
    }, true)
}

export function ingestIncomingMessages(sessionId: string, incoming: DecryptedMessage[]): void {
    if (incoming.length === 0) return
    updateState(sessionId, (previous) => {
        let merged = mergeIntoWindow(previous, incoming, {
            advanceTailRevision: true
        })
        if (merged.epoch === null || merged.requiresLatestReset) {
            return merged
        }
        const incomingNewest = derivePosition(incoming, 'newest')
        const currentNewest = getNewestCursor(merged)
        const newest = incomingNewest && (!currentNewest || comparePosition(incomingNewest, currentNewest) > 0)
            ? incomingNewest
            : currentNewest
        merged = buildState(merged, {
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null
        })
        return merged
    })
}

export function getMessageWindowState(sessionId: string): MessageWindowState {
    return getState(sessionId)
}

export function subscribeMessageWindow(sessionId: string, listener: () => void): () => void {
    const subscribers = listeners.get(sessionId) ?? new Set()
    subscribers.add(listener)
    listeners.set(sessionId, subscribers)
    return () => {
        const current = listeners.get(sessionId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) {
            listeners.delete(sessionId)
        }
    }
}

export function clearMessageWindow(sessionId: string): void {
    tailSyncControllers.delete(sessionId)
    clearPersistedState(sessionId)
    const previous = states.get(sessionId)
    if (!previous) return
    setState(sessionId, {
        ...createState(sessionId),
        syncGeneration: previous.syncGeneration + 1,
        olderGeneration: previous.olderGeneration + 1
    }, true)
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
    const source = getState(fromSessionId)
    const target = getState(toSessionId)
    const seeded = buildState(createState(toSessionId), {
        messages: [...source.messages],
        hasMore: source.hasMore,
        tailRevision: source.tailRevision,
        oldestPositionAt: source.oldestPositionAt,
        oldestPositionSeq: source.oldestPositionSeq,
        historyBoundaryAt: source.historyBoundaryAt,
        historyBoundarySeq: source.historyBoundarySeq,
        provisionalBoundaryGeneration: null,
        requiresLatestReset: true,
        syncGeneration: target.syncGeneration + 1,
        olderGeneration: target.olderGeneration + 1
    })
    tailSyncControllers.delete(toSessionId)
    setState(toSessionId, seeded, true)
}

function isQueuedReconcileCandidate(message: DecryptedMessage): boolean {
    if (!message.localId || !isQueuedForInvocation(message)) return false
    if (!optimisticMessage(message)) return true
    return message.status === 'queued' || message.status === 'sent'
}

export function getQueuedReconcileCandidateLocalIds(sessionId: string): string[] {
    const localIds = new Set<string>()
    for (const message of getState(sessionId).messages) {
        if (isQueuedReconcileCandidate(message)) {
            localIds.add(message.localId!)
        }
    }
    return [...localIds]
}

export function reconcileQueuedLocalIds(
    sessionId: string,
    candidateLocalIds: string[],
    queuedLocalIds: string[]
): void {
    if (candidateLocalIds.length === 0) return
    const candidates = new Set(candidateLocalIds)
    const queued = new Set(queuedLocalIds)
    updateState(sessionId, (previous) => {
        const messages = previous.messages.filter((message) => {
            if (!message.localId || !candidates.has(message.localId)) return true
            return queued.has(message.localId) || !isQueuedReconcileCandidate(message)
        })
        return messages.length === previous.messages.length
            ? previous
            : buildState(previous, { messages })
    }, true)
}

export function appendOptimisticMessage(sessionId: string, message: DecryptedMessage): void {
    updateState(sessionId, (previous) => {
        return mergeIntoWindow(previous, [message], {
            mode: previous.viewMode === 'history' ? 'prepend' : 'append',
            advanceTailRevision: true
        })
    }, true)
}

export function updateMessageStatus(sessionId: string, localId: string, status: MessageStatus): void {
    if (!localId) return
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (message.localId !== localId || message.status === status) return message
            changed = true
            return { ...message, status }
        })
        return changed ? buildState(previous, { messages }) : previous
    })
}

export function removeOptimisticMessage(sessionId: string, localId: string): void {
    if (!localId) return
    updateState(sessionId, (previous) => {
        const messages = previous.messages.filter(
            (message) => message.localId !== localId && message.id !== localId
        )
        return messages.length === previous.messages.length
            ? previous
            : buildState(previous, { messages })
    }, true)
}

export function markMessagesIndeterminate(sessionId: string, localIds: string[]): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId) || message.deliveryState === 'indeterminate') {
                return message
            }
            changed = true
            return { ...message, deliveryState: 'indeterminate' as const }
        })
        return changed ? buildState(previous, { messages }) : previous
    }, true)
}

export function markMessagesRequeued(sessionId: string, localIds: string[]): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId) || message.deliveryState === undefined) {
                return message
            }
            changed = true
            const { deliveryState: _deliveryState, ...requeued } = message
            return requeued
        })
        return changed ? buildState(previous, { messages }) : previous
    }, true)
}

export function markMessagesConsumed(
    sessionId: string,
    localIds: string[],
    invokedAt: number,
    steered?: boolean
): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const updated = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId) || message.status === 'failed') {
                return message
            }
            const needsStatus = message.status !== 'sent'
            const needsInvokedAt = message.invokedAt === null
            const needsSteered = steered === true && message.steered !== true
            if (!needsStatus && !needsInvokedAt && !needsSteered) return message
            changed = true
            const { deliveryState: _deliveryState, ...withoutDeliveryState } = message
            return {
                ...withoutDeliveryState,
                ...(needsStatus ? { status: 'sent' as MessageStatus } : {}),
                ...(needsInvokedAt ? { invokedAt } : {}),
                ...(needsSteered ? { steered: true } : {})
            }
        })
        if (!changed) return previous
        return buildState(previous, {
            messages: mergeMessages([], updated),
            tailRevision: previous.tailRevision + 1
        })
    })
}

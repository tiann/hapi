import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { getReasoningStreamId, unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, isEligibleForToolGrouping } from '@/chat/toolGroups'
import type { NormalizedMessage } from '@/chat/types'
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

/** Result of walking a context window forward toward the session head. */
export type NewerLoadOutcome =
    | { kind: 'loaded'; added: number }
    /** The window reached the head; tail mode is now a valid transition. */
    | { kind: 'caught-up'; added: number }
    | {
        kind: 'stopped'
        reason: 'unavailable' | 'busy' | 'invalidated' | 'epoch-reset' | 'exhausted' | 'failed'
    }

export type MessageWindowState = {
    readThroughRevision?: number
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
    // A history window may be intentionally retained while its latest-tail
    // cursor is invalid. Consumers must treat that window as provisional
    // until the next tail reconciliation completes.
    requiresLatestReset: boolean
    // Gap-recovery pending: the next tail sync must catch up the missed
    // interval and then reconcile an authoritative latest page as an upsert.
    pendingGapRecovery: boolean
    /**
     * A search/context window stops short of the session head. True while
     * newer messages exist between the loaded window and that head, so the
     * reader can keep going forward instead of only paging backward.
     */
    hasMoreNewer: boolean
    messagesVersion: number
    historyVersion: number
    tailRevision: number
}

export const VISIBLE_WINDOW_SIZE = 400
export const HISTORY_WINDOW_SIZE = 600
export const INITIAL_PAGE_SIZE = 20
const AGENT_RUN_WINDOW_SIZE = 800
export const OLDER_LOAD_WINDOW_SIZE = 800
const PAGE_SIZE = 200
const CACHED_REENTRY_PAGE_SIZE = 20
// ponytail: fixed budget suggested in #2045, not field-measured; tune from load timings.
const INITIAL_CONTEXT_WAIT_MS = 500
// Gap recovery refreshes at most this many retained non-terminal tool-call
// rows through the message-context endpoint (newest first). Live calls are a
// handful; the bound keeps a pathological window from fanning out requests.
const GAP_ROW_REFRESH_LIMIT = 20

type MessagePosition = {
    at: number
    seq: number
}

type InternalState = MessageWindowState & {
    oldestPositionAt: number | null
    oldestPositionSeq: number | null
    newestPositionAt: number | null
    newestPositionSeq: number | null
    // Newest row actually loaded by a context jump. newestPosition* holds the
    // session head so tail sync stays correct; this is the forward-paging
    // cursor for the gap between the two.
    contextNewestAt: number | null
    contextNewestSeq: number | null
    requiresLatestReset: boolean
    preferLatestOnActivation: boolean
    // A gap resume asked for an authoritative latest page applied as an
    // upsert: rows the window holds are replaced by id, but already-loaded
    // history outside the latest page and the oldest cursor survive the
    // reconciliation.
    pendingGapRecovery: boolean
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
    contextNewestAt: number | null
    contextNewestSeq: number | null
    epoch: number | null
    requiresLatestReset: boolean
}

type TailSyncController = {
    api: ApiClient
    running: Promise<void> | null
    trailingRequested: boolean
    runningPrefersLatest: boolean
    runningPendingRecovery: boolean
}

const states = new Map<string, InternalState>()
const listeners = new Map<string, Set<() => void>>()
const tailSyncControllers = new Map<string, TailSyncController>()
const messageWindowTargetLocks = new Set<string>()
const appliedRewindLocalIds = new Map<string, Set<string>>()

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
            contextNewestAt: state.contextNewestAt,
            contextNewestSeq: state.contextNewestSeq,
            epoch: state.epoch,
            requiresLatestReset: state.requiresLatestReset
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
        contextNewestAt: null,
        contextNewestSeq: null,
        hasMoreNewer: false,
        requiresLatestReset: false,
        preferLatestOnActivation: false,
        pendingGapRecovery: false,
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
        const contextNewest = readPosition(parsed.contextNewestAt, parsed.contextNewestSeq)
        const epoch = typeof parsed.epoch === 'number' && Number.isInteger(parsed.epoch) && parsed.epoch >= 0
            ? parsed.epoch
            : null
        // Older v2 entries did not persist this bit. Treat non-empty legacy
        // windows as provisional once so a historical context cannot be
        // mistaken for the current tail after a reload.
        const requiresLatestReset = typeof parsed.requiresLatestReset === 'boolean'
            ? parsed.requiresLatestReset
            : parsed.messages.length > 0 && (newest === null || epoch === null)
        return buildState(createState(sessionId), {
            messages: mergeMessages([], parsed.messages.map(restoreMessage)),
            hasMore: parsed.hasMore === true,
            oldestPositionAt: oldest?.at ?? null,
            oldestPositionSeq: oldest?.seq ?? null,
            newestPositionAt: newest?.at ?? null,
            newestPositionSeq: newest?.seq ?? null,
            contextNewestAt: contextNewest?.at ?? null,
            contextNewestSeq: contextNewest?.seq ?? null,
            // Reading forward resumes after a reload only while the restored
            // window still stops short of the head.
            hasMoreNewer: contextNewest !== null
                && newest !== null
                && comparePosition(contextNewest, newest) < 0,
            epoch,
            requiresLatestReset
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
    // A latest-reset state still contains the previous server snapshot. Do not
    // persist that stale window while the authoritative replacement is in
    // flight; a reload during the reset must not resurrect removed messages.
    if (next.requiresLatestReset) {
        pendingPersistSessionIds.delete(sessionId)
    } else {
        schedulePersist(sessionId)
    }
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
        | 'readThroughRevision'
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
        | 'contextNewestAt'
        | 'contextNewestSeq'
        | 'hasMoreNewer'
        | 'requiresLatestReset'
        | 'preferLatestOnActivation'
        | 'pendingGapRecovery'
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

/** Pick the dropped Agent/Task tool calls that spawned sidechain rows still in
 *  the window. The tracer can only attach sidechain rows to their parent card,
 *  so trimming the parent away hides every row of a long subagent run and can
 *  leave the tail showing a single message. */
function findDroppedSubagentParents(
    kept: DecryptedMessage[],
    dropped: DecryptedMessage[]
): DecryptedMessage[] {
    if (dropped.length === 0) return []
    const parentToolUseIds = new Set<string>()
    for (const message of kept) {
        const normalized = normalizeDecryptedMessage(message)
        if (normalized?.isSidechain && normalized.parentToolUseId) {
            parentToolUseIds.add(normalized.parentToolUseId)
        }
    }
    if (parentToolUseIds.size === 0) return []
    return dropped.filter((message) => {
        const normalized = normalizeDecryptedMessage(message)
        return normalized?.role === 'agent' && normalized.content.some((content) => (
            content.type === 'tool-call' && parentToolUseIds.has(content.id)
        ))
    })
}

function trimPreservingQueued(
    incoming: DecryptedMessage[],
    regularLimit: number,
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[]; oldest: MessagePosition | null } {
    const messages = dropSupersededReasoningSnapshots(incoming)
    const queued = messages.filter(isQueuedForInvocation)
    const queuedIds = new Set(queued.map((message) => message.id))
    const nonQueued = messages.filter((message) => !queuedIds.has(message.id))
    const agentRuns = nonQueued.filter(isCodexAgentRunMessage)
    const regular = nonQueued.filter((message) => !isCodexAgentRunMessage(message))
    const regularTrim = sliceForTrim(regular, Math.max(0, regularLimit - queued.length), mode)
    const agentRunTrim = sliceForTrim(agentRuns, AGENT_RUN_WINDOW_SIZE, mode)
    const kept = mergeMessages([...regularTrim.kept, ...agentRunTrim.kept], queued)
    const parents = findDroppedSubagentParents(regularTrim.kept, regularTrim.dropped)
    const parentIds = new Set(parents.map((message) => message.id))
    return {
        kept: parents.length > 0 ? mergeMessages(kept, parents) : kept,
        dropped: [
            ...regularTrim.dropped.filter((message) => !parentIds.has(message.id)),
            ...agentRunTrim.dropped
        ],
        // Pinned parents sit outside the contiguous window; paging older must
        // resume from the window edge, not from them, or the gap is skipped.
        oldest: derivePosition(kept, 'oldest')
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
    const { kept, dropped, oldest: oldestKept } = trimPreservingQueued(merged, regularLimit, mode)
    let next = buildState(previous, {
        messages: kept,
        ...(options.advanceTailRevision
            ? { tailRevision: previous.tailRevision + 1 }
            : {})
    })
    if (dropped.length === 0) {
        return next
    }
    if (mode === 'append') {
        return buildState(next, {
            hasMore: true,
            oldestPositionAt: oldestKept?.at ?? next.oldestPositionAt,
            oldestPositionSeq: oldestKept?.seq ?? next.oldestPositionSeq
        })
    }
    const forwardCursor = readPosition(previous.contextNewestAt, previous.contextNewestSeq)
    // A hit already inside the rendered window skips loadMessageContext, so it
    // has no cursor yet. Once older paging trims newer rows off such a
    // search-locked window those messages become unreachable, so seed the
    // cursor here from what is retained.
    const searchLocked = messageWindowTargetLocks.has(previous.sessionId)
    if (forwardCursor || searchLocked) {
        // A context window deliberately keeps the authoritative session head
        // in newestPosition*. Replacing it with the retained boundary (as the
        // ordinary tail case does below) would make forward reading believe it
        // had caught up with itself. Clamp the forward cursor instead, so any
        // caller that trims from the newest end — older pages and live SSE
        // alike — stays consistent.
        const contiguousNewest = derivePosition(
            kept.filter((message) => (
                !isQueuedForInvocation(message) && !optimisticMessage(message)
            )),
            'newest'
        )
        const clamped = !forwardCursor
            ? contiguousNewest
            : contiguousNewest && comparePosition(contiguousNewest, forwardCursor) < 0
                ? contiguousNewest
                : forwardCursor
        const head = readPosition(previous.newestPositionAt, previous.newestPositionSeq)
        return buildState(next, {
            requiresLatestReset: true,
            contextNewestAt: clamped?.at ?? previous.contextNewestAt,
            contextNewestSeq: clamped?.seq ?? previous.contextNewestSeq,
            hasMoreNewer: clamped !== null
                && head !== null
                && comparePosition(clamped, head) < 0
        })
    }
    const newest = derivePosition(kept, 'newest')
    next = buildState(next, {
        requiresLatestReset: true,
        newestPositionAt: newest?.at ?? null,
        newestPositionSeq: newest?.seq ?? null
    })
    return next
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
        trimLimit?: number
    }
): InternalState {
    const dismissedIds = new Set(
        previous.messages
            .filter((message) => message.queueDismissed)
            .map((message) => message.id)
    )
    const retainedResponseMessages = response.messages
        .filter(shouldRetainWindowMessage)
        .map((message) => (
            dismissedIds.has(message.id)
            && message.invokedAt === null
            && message.deliveryState === 'indeterminate'
                ? { ...message, queueDismissed: true }
                : message
        ))
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
    const { kept, dropped, oldest: oldestKept } = trimPreservingQueued(incoming, options.trimLimit ?? VISIBLE_WINDOW_SIZE, 'append')
    const snapshotHead = pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
        ?? derivePosition(response.messages, 'newest')
    const newestKept = derivePosition(kept, 'newest')
    const newest = snapshotHead && newestKept
        ? (comparePosition(snapshotHead, newestKept) >= 0 ? snapshotHead : newestKept)
        : snapshotHead ?? newestKept
    const responseOldest = pagePosition(response.page.nextBeforeAt, response.page.nextBeforeSeq)
    const previousOldest = readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    const oldest = dropped.length > 0
        ? oldestKept
        : options.replaceServerRows
            ? responseOldest
            // An upsert keeps rows older than the response page, so the
            // older-paging cursor must stay on whichever side is older
            // instead of jumping to the response page's own bound.
            : (responseOldest && previousOldest
                ? (comparePosition(responseOldest, previousOldest) <= 0 ? responseOldest : previousOldest)
                : responseOldest ?? previousOldest)
    return buildState(previous, {
        messages: kept,
        readThroughRevision: Math.max(previous.readThroughRevision ?? 0, response.page.readThroughRevision ?? 0,
            ...kept.map(message => message.contentRevision ?? 0)),
        hasMore: response.page.hasMore || (!options.replaceServerRows && previous.hasMore) || dropped.length > 0,
        epoch: response.page.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: newest?.at ?? null,
        newestPositionSeq: newest?.seq ?? null,
        tailRevision: previous.tailRevision + 1,
        requiresLatestReset: false,
        // An authoritative latest window replaces the context entirely.
        ...(options.replaceServerRows
            ? { contextNewestAt: null, contextNewestSeq: null, hasMoreNewer: false }
            : {}),
        isLoadingMore: options.replaceServerRows ? false : previous.isLoadingMore,
        olderGeneration: options.replaceServerRows
            ? previous.olderGeneration + 1
            : previous.olderGeneration,
        warning: null
    })
}

function beginTailSync(sessionId: string): number {
    let generation = 0
    updateState(sessionId, (previous) => {
        generation = previous.syncGeneration + 1
        return buildState(previous, {
            syncGeneration: generation,
            // Tail reconciliation owns the authoritative epoch. An older-page
            // response captured before this point must not commit while the tail
            // request is in flight, or a reset can mistake it for concurrent SSE.
            olderGeneration: previous.olderGeneration + 1,
            isSyncingTail: true,
            isLoadingMore: false,
            warning: null
        })
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

/** A cached tool-call row that can still be enriched in place: its payload is
 *  a live `tool-call` whose merged status has not reached a terminal tier.
 *  Terminal rows are done; unknown or missing status reads as pending. */
function isNonTerminalToolCallRow(message: DecryptedMessage): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record?.role !== 'agent') return false
    const content = record.content
    if (!content || typeof content !== 'object') return false
    const payload = content as { type?: unknown; data?: unknown }
    if (payload.type !== AGENT_MESSAGE_PAYLOAD_TYPE || !payload.data || typeof payload.data !== 'object') {
        return false
    }
    const data = payload.data as { type?: unknown; status?: unknown }
    if (data.type !== 'tool-call') return false
    return data.status !== 'completed' && data.status !== 'failed'
}

function isToolOnlyPage(messages: DecryptedMessage[]): boolean {
    const normalized: NormalizedMessage[] = []
    for (const message of messages) {
        // Queued prompts render above the composer, not in the thread.
        if (!shouldRetainWindowMessage(message) || isQueuedForInvocation(message)) continue
        const next = normalizeDecryptedMessage(message)
        if (next) normalized.push(next)
    }
    const { blocks } = reduceChatBlocks(normalized, null)
    return buildVisibleChatBlocks(blocks, { hasMoreMessages: true }).every((block) => (
        block.kind === 'tool-group'
        || (block.kind === 'tool-call' && isEligibleForToolGrouping(block))
    ))
}

// A cold tail page made only of tool activity renders as one collapsed card.
// Fetch one older page before first paint so the preceding conversation is
// visible; a timeout, failure, or epoch change falls back to the tail page.
async function fetchInitialContextPage(
    api: ApiClient,
    sessionId: string,
    latest: MessagesResponse
): Promise<MessagesResponse | null> {
    const before = pagePosition(latest.page.nextBeforeAt, latest.page.nextBeforeSeq)
    if (!latest.page.hasMore || !before || !isToolOnlyPage(latest.messages)) {
        return null
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const context = await Promise.race([
            api.getMessages(sessionId, {
                beforeAt: before.at,
                beforeSeq: before.seq,
                limit: PAGE_SIZE
            }).catch(() => null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), INITIAL_CONTEXT_WAIT_MS)
            })
        ])
        return context && context.page.epoch === latest.page.epoch ? context : null
    } finally {
        clearTimeout(timer)
    }
}

async function runTailSync(api: ApiClient, sessionId: string): Promise<void> {
    const generation = beginTailSync(sessionId)
    try {
        const initial = getState(sessionId)
        const initialCursor = getNewestCursor(initial)
        const preferLatestOnActivation = initial.preferLatestOnActivation
        const pendingGapRecovery = initial.pendingGapRecovery
        const canIncrement = initialCursor !== null
            && initial.epoch !== null
            && !initial.requiresLatestReset
            // A pending gap recovery must run its cursor catch-up even when a
            // cached activation asked for a direct latest page: the activation
            // shortcut fetches only the newest rows and leaves the interval
            // between the cached tail and the page unreachable below the
            // advanced newest cursor.
            && (!preferLatestOnActivation || pendingGapRecovery)

        if (canIncrement && preferLatestOnActivation) {
            // The recovery's catch-up + latest-page reconciliation subsumes
            // the cached-activation refresh. Defer the activation shortcut for
            // this run: left set, it would force-break the catch-up loop after
            // its first chunk.
            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                return buildState(previous, { preferLatestOnActivation: false })
            })
        }

        if (!canIncrement) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            // Cold windows and cached re-entry prioritize the newest usable
            // messages for first paint. Structural resets and cursor-backed
            // non-activation synchronization use the full page so their
            // authoritative replacement remains unchanged.
            const isColdWindow = !initial.requiresLatestReset
                && !preferLatestOnActivation
                && initialCursor === null
            const latestPageSize = initial.requiresLatestReset || pendingGapRecovery
                ? PAGE_SIZE
                : preferLatestOnActivation
                    ? CACHED_REENTRY_PAGE_SIZE
                    : isColdWindow
                        ? INITIAL_PAGE_SIZE
                        : PAGE_SIZE
            const response = await api.getMessages(sessionId, { limit: latestPageSize })
            if (!isCurrentTailSync(sessionId, generation)) return
            const context = isColdWindow
                ? await fetchInitialContextPage(api, sessionId, response)
                : null
            if (!isCurrentTailSync(sessionId, generation)) return
            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                const next = applyLatestResponse(previous, response, {
                    // Gap recovery reconciles by id so already-loaded history
                    // outside the latest page survives; only a structural
                    // reset, a server reset verdict, or an epoch change (a
                    // remote rewind whose messages-invalidated event was
                    // missed can have deleted held rows) may replace rows.
                    replaceServerRows: initial.requiresLatestReset
                        || response.page.reset
                        || (initial.epoch !== null && response.page.epoch !== initial.epoch)
                        || (preferLatestOnActivation && !pendingGapRecovery),
                    requestBaseline
                })
                if (!context) {
                    return buildState(next, { preferLatestOnActivation: false, pendingGapRecovery: false })
                }
                return buildState(mergeIntoWindow(next, context.messages, { mode: 'prepend' }), {
                    preferLatestOnActivation: false,
                    pendingGapRecovery: false,
                    hasMore: context.page.hasMore,
                    oldestPositionAt: context.page.nextBeforeAt,
                    oldestPositionSeq: context.page.nextBeforeSeq
                })
            })
            finishTailSync(sessionId, generation, null)
            return
        }

        let after = initialCursor
        let until: MessagePosition | null = null
        let catchUpReset = false
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
                catchUpReset = true
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
                    readThroughRevision: Math.max(merged.readThroughRevision ?? 0, response.page.readThroughRevision ?? 0,
                        ...merged.messages.map(message => message.contentRevision ?? 0)),
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

        if (pendingGapRecovery) {
            if (catchUpReset) {
                // A reset verdict already replaced the window authoritatively
                // under the server's epoch; there is nothing left to refresh.
                updateState(sessionId, (previous) => {
                    if (previous.syncGeneration !== generation) return previous
                    return buildState(previous, {
                        pendingGapRecovery: false,
                        preferLatestOnActivation: false
                    })
                })
            } else if (getState(sessionId).requiresLatestReset) {
                // The catch-up overflowed the window's history budget:
                // history-mode trimming dropped the newer caught-up rows and
                // marked the window for a reset. Reconciling the latest page
                // on top would strand the rows between the reset-marked
                // window and the page — unreachable from either cursor — so
                // leave the reset requirement and the recovery flags intact:
                // the next sync's authoritative replacement closes the hole
                // and consumes the flags.
            } else {
                // The cursor phase caught the window up without error. Only
                // now may the recovery advance to the latest page: reconciling
                // after a failed catch-up would strand the rows between the
                // cached tail and the page below the advanced newest cursor.
                // On a catch-up failure the catch above skips this block, the
                // original cursor and the flag survive, and the next sync
                // retries the whole recovery.
                const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
                const response = await api.getMessages(sessionId, { limit: PAGE_SIZE })
                if (!isCurrentTailSync(sessionId, generation)) return
                updateState(sessionId, (previous) => {
                    if (previous.syncGeneration !== generation) return previous
                    const trimLimit = Math.min(OLDER_LOAD_WINDOW_SIZE, Math.max(VISIBLE_WINDOW_SIZE, previous.messages.length))
                    const next = applyLatestResponse(previous, response, {
                        replaceServerRows: response.page.reset
                            || (previous.epoch !== null && response.page.epoch !== previous.epoch),
                        requestBaseline,
                        trimLimit
                    })
                    // The activation flag is consumed here — the upsert
                    // subsumed its refresh — but the recovery stays pending
                    // until the row sweep below succeeds, so a failed context
                    // request retries on the next sync instead of leaving the
                    // enriched cached call stale with no retry path.
                    return buildState(next, { preferLatestOnActivation: false })
                })

                // A tool-call row the client cached before the gap can be
                // enriched in place afterwards; when more than a latest page of
                // newer rows followed, neither the catch-up (newer rows only)
                // nor the page reaches it, and the cached card keeps its stale
                // input/status. Refresh those retained non-terminal rows by id
                // through the existing message-context endpoint: bounded,
                // newest first, best-effort, and skipped for rows the catch-up
                // already delivered fresh (at or after the recovery cursor).
                const pageOldest = pagePosition(response.page.nextBeforeAt, response.page.nextBeforeSeq)
                if (pageOldest) {
                    const refreshCandidates = getState(sessionId).messages
                        .filter((message) => {
                            const position = messagePosition(message)
                            if (!position || comparePosition(position, pageOldest) >= 0) return false
                            if (initialCursor && comparePosition(position, initialCursor) > 0) return false
                            return isNonTerminalToolCallRow(message)
                        })
                        .sort((left, right) => comparePosition(
                            messagePosition(right) as MessagePosition,
                            messagePosition(left) as MessagePosition
                        ))
                        .slice(0, GAP_ROW_REFRESH_LIMIT)
                    for (const candidate of refreshCandidates) {
                        // A failed refresh propagates to runTailSync's catch and
                        // surfaces the usual warning; the row stays as is and
                        // the recovery stays pending, so the next sync —
                        // ordinary or recovery — retries the whole sweep.
                        const context = await api.getMessageContext(sessionId, candidate.id)
                        if (!isCurrentTailSync(sessionId, generation)) return
                        const refreshed = context?.messages.find((message) => message.id === candidate.id)
                        if (!refreshed) {
                            // The row is no longer reachable through the
                            // context endpoint: leave it as is and finish the
                            // run's bookkeeping — an early return here would
                            // leave the window marked syncing.
                            finishTailSync(sessionId, generation, 'Failed to refresh a merged tool call')
                            return
                        }
                        if (context!.page.epoch !== getState(sessionId).epoch) {
                            // The refresh answered under a different epoch:
                            // server rows may have been deleted since the
                            // page was fetched. Mark the window for the
                            // authoritative replacement instead of
                            // reconciling against a stale snapshot, and
                            // finish the run's bookkeeping.
                            updateState(sessionId, (previous) => {
                                if (previous.syncGeneration !== generation) return previous
                                return buildState(previous, { requiresLatestReset: true })
                            })
                            finishTailSync(sessionId, generation, 'Failed to refresh a merged tool call')
                            return
                        }
                        updateState(sessionId, (previous) => {
                            if (previous.syncGeneration !== generation) return previous
                            return buildState(previous, { messages: mergeMessages(previous.messages, [refreshed]) })
                        })
                    }
                }

                // The catch-up, the upsert, and every row refresh succeeded:
                // only now is the recovery complete.
                updateState(sessionId, (previous) => {
                    if (previous.syncGeneration !== generation) return previous
                    return buildState(previous, { pendingGapRecovery: false })
                })
            }
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
    const runningPendingRecovery = getState(sessionId).pendingGapRecovery
    const running = runTailSync(controller.api, sessionId)
    controller.running = running
    controller.runningPrefersLatest = runningPrefersLatest
    controller.runningPendingRecovery = runningPendingRecovery
    const finish = () => {
        if (tailSyncControllers.get(sessionId) !== controller || controller.running !== running) {
            return
        }
        controller.running = null
        controller.runningPrefersLatest = false
        controller.runningPendingRecovery = false
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
    const { kept, dropped, oldest: oldestKept } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
    const forceLatest = previous.requiresLatestReset
    const oldest = dropped.length > 0
        ? oldestKept
        : readPosition(previous.oldestPositionAt, previous.oldestPositionSeq)
    return buildState(previous, {
        messages: kept,
        hasMore: previous.hasMore || dropped.length > 0,
        viewMode: 'tail',
        epoch: forceLatest ? null : previous.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: forceLatest ? null : previous.newestPositionAt,
        newestPositionSeq: forceLatest ? null : previous.newestPositionSeq,
        // The context window is being left behind; its forward cursor must not
        // outlive it, or a later hit that is already inside the latest window
        // would page from the old historical position and splice disconnected
        // messages in ahead of the tail.
        contextNewestAt: null,
        contextNewestSeq: null,
        hasMoreNewer: false
    })
}

export function activateMessageWindow(sessionId: string): void {
    if (messageWindowTargetLocks.has(sessionId)) {
        return
    }
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
    if (messageWindowTargetLocks.has(sessionId)) {
        return Promise.resolve()
    }
    let controller = tailSyncControllers.get(sessionId)
    if (!controller) {
        controller = {
            api,
            running: null,
            trailingRequested: false,
            runningPrefersLatest: false,
            runningPendingRecovery: false
        }
        tailSyncControllers.set(sessionId, controller)
    }
    controller.api = api
    if (!controller.running) {
        return startTailSync(sessionId, controller)
    }
    const state = getState(sessionId)
    if (state.preferLatestOnActivation || state.pendingGapRecovery) {
        // A running sync snapshotted its mode at start; a newly requested
        // latest reconciliation (cached re-entry or gap recovery) must not
        // let that older run commit a plain cursor merge or a full
        // replacement over it.
        if (controller.runningPrefersLatest && !state.pendingGapRecovery) {
            return controller.running
        }
        if (controller.runningPendingRecovery && state.pendingGapRecovery) {
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

/**
 * One gap-recovery step for a session message window.
 *
 * A resumed-with-gap connection (`resume: 'gap'`) cannot prove continuity,
 * and in-place row updates (merged tool-call ticks) keep the row's original
 * cursor position, so a plain cursor sync re-delivers new rows but never the
 * merged content of rows the window already holds. Force an authoritative
 * latest page and apply it as an upsert instead of replacing the window: rows
 * present in the response are replaced by id, while already-loaded rows older
 * than the latest page and the hasMore/oldest cursor and context survive. An
 * older load caught in flight is invalidated like on every tail sync (the
 * generation bump) and is simply re-requested by the user's scroll. Rows
 * older than the latest page are not re-fetched — a live tool-call tick
 * always updates a row inside the newest page, so in-place updates are
 * recovered without discarding scrolled-back history. A failed recovery
 * fetch leaves the flag set, so the next sync retries the latest page. Cold
 * or structurally invalidated windows have nothing to preserve and keep the
 * plain reset choreography.
 *
 * The latest page only covers the newest rows, so a warm window whose cached
 * tail sits below the page's oldest row would keep a permanent hole between
 * the two (the advanced newest cursor never fills it). The catch-up therefore
 * runs first: a plain cursor sync pulls every row the window missed, then the
 * upsert refreshes in-place merged rows. Cost: one extra round trip on
 * reconnect.
 */
export function recoverWindowAfterGapResume(api: ApiClient, sessionId: string): Promise<void> {
    if (messageWindowTargetLocks.has(sessionId)) {
        return Promise.resolve()
    }
    const previous = states.get(sessionId)
    if (
        !previous
        || previous.requiresLatestReset
        || getNewestCursor(previous) === null
        || previous.epoch === null
    ) {
        return syncTailMessages(api, sessionId)
    }
    updateState(sessionId, (current) => buildState(current, { pendingGapRecovery: true }))
    return syncTailMessages(api, sessionId)
}

/**
 * Mark a session as being opened for a specific historical search target.
 * Background reconnect/SSE refreshes must not reclaim that window before the
 * targeted context has rendered.
 */
export function setMessageWindowTargetLock(sessionId: string, locked: boolean): void {
    if (locked) {
        messageWindowTargetLocks.add(sessionId)
        cancelTailSync(sessionId)
        return
    }
    messageWindowTargetLocks.delete(sessionId)
}

/**
 * Drop an in-flight latest-page reconciliation when a targeted history load
 * takes ownership of the window. The request itself cannot always be aborted
 * after fetch has started, but invalidating its generation prevents its large
 * response from replacing the historical context when it eventually arrives.
 */
export function cancelTailSync(sessionId: string): void {
    const controller = tailSyncControllers.get(sessionId)
    const state = getState(sessionId)
    if (!controller?.running && !state.isSyncingTail) {
        return
    }
    tailSyncControllers.delete(sessionId)
    updateState(sessionId, (previous) => buildState(previous, {
        syncGeneration: previous.syncGeneration + 1,
        isSyncingTail: false,
        warning: null
    }), true)
}

export async function fetchOlderMessages(
    api: ApiClient,
    sessionId: string,
    options: {
        onBeforeApply?: (historyVersion: number) => boolean
    } = {}
): Promise<OlderLoadOutcome> {
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
            const current = getState(sessionId)
            if (current.olderGeneration !== generation) {
                return { kind: 'stopped', reason: 'invalidated' }
            }
            markMessageWindowForLatestReset(sessionId, current.messages)
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
                return buildState(previous, {
                    olderGeneration: previous.olderGeneration + 1,
                    isLoadingMore: false,
                    warning: null
                })
            }
            const merged = mergeIntoWindow(previous, response.messages, {
                mode: 'prepend',
                regularLimit: OLDER_LOAD_WINDOW_SIZE
            })
            historyVersion = nextHistoryVersion
            // Cursor clamping and head preservation now happen inside
            // mergeIntoWindow, so every path that trims from the newest end
            // behaves the same.
            return buildState(merged, {
                hasMore: response.page.hasMore,
                epoch: response.page.epoch,
                oldestPositionAt: response.page.nextBeforeAt,
                oldestPositionSeq: response.page.nextBeforeSeq,
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
            return buildState(previous, {
                isLoadingMore: false,
                warning: loadError.message
            })
        })
        return { kind: 'failed', error: loadError }
    }
}

/**
 * Replace the server portion of the window with a bounded context around a
 * search hit. This avoids walking hundreds of older pages just to reveal one
 * message, while keeping queued/optimistic local rows visible.
 */
export async function loadMessageContext(
    api: ApiClient,
    sessionId: string,
    messageId: string
): Promise<boolean> {
    // HappyThread may call this from a child layout effect. Yield to the next
    // task so the parent useMessages layout effect can register the initial
    // tail sync before we inspect the window and start a competing context
    // request.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    let initial = getState(sessionId)
    const activeTailSync = tailSyncControllers.get(sessionId)
    if (initial.isSyncingTail || activeTailSync?.running) {
        if (activeTailSync?.running) {
            await waitForTailSyncDrain(sessionId, activeTailSync, activeTailSync.running)
        }
        initial = getState(sessionId)
    }
    if (initial.isSyncingTail || initial.isLoadingMore) {
        return false
    }

    const requestBaseline = new Map(initial.messages.map((message) => [message.id, message]))
    const generation = initial.olderGeneration + 1
    updateState(sessionId, (previous) => buildState(previous, {
        olderGeneration: generation,
        isLoadingMore: true,
        warning: null
    }), true)

    try {
        const response = await api.getMessageContext(sessionId, messageId)
        if (getState(sessionId).olderGeneration !== generation) {
            return false
        }

        if (!response) {
            updateState(sessionId, (previous) => {
                if (previous.olderGeneration !== generation) return previous
                return buildState(previous, {
                    // The cached window may predate appends or a rewind. Force
                    // the next tail sync to replace it instead of leaving a
                    // stale suffix rendered behind the dismissed jump.
                    requiresLatestReset: previous.messages.length > 0 || previous.requiresLatestReset,
                    isLoadingMore: false,
                    warning: null
                })
            }, true)
            return false
        }

        const retained = response.messages.filter(shouldRetainWindowMessage)
        if (!retained.some((message) => message.id === response.targetMessageId)) {
            updateState(sessionId, (previous) => {
                if (previous.olderGeneration !== generation) return previous
                return buildState(previous, {
                    requiresLatestReset: previous.messages.length > 0 || previous.requiresLatestReset,
                    isLoadingMore: false,
                    warning: 'The searched message is no longer available'
                })
            }, true)
            return false
        }

        let applied = false
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous

            const preservedLocalMessages = previous.messages.filter((message) => (
                optimisticMessage(message) || isQueuedForInvocation(message)
            ))
            const concurrentMessages = previous.messages.filter((message) => (
                requestBaseline.get(message.id) !== message
            ))
            const merged = mergeMessages(
                mergeMessages(preservedLocalMessages, retained),
                concurrentMessages
            )
            const { kept } = trimPreservingQueued(merged, OLDER_LOAD_WINDOW_SIZE, 'prepend')
            applied = true
            // The window stops well short of the head. Keep newestPosition* on
            // the head for tail sync, and track the window's own newest row
            // separately so the reader can page forward across the gap.
            // Derive from the contiguous context rows only. `kept` also holds
            // rows that arrived over SSE while the request was in flight, and
            // the hub deliberately appends pending prompts to the context
            // response out-of-band ("pending rows must not change the bounded
            // context's pagination cursor", messageService.ts). Either would
            // push the cursor past the window and strand the history between.
            const contiguous = retained.filter((message) => (
                !isQueuedForInvocation(message) && !optimisticMessage(message)
            ))
            const contextNewest = derivePosition(contiguous, 'newest')
            const snapshotHead = pagePosition(
                response.page.snapshotHeadAt,
                response.page.snapshotHeadSeq
            )
            return buildState(previous, {
                messages: kept,
                hasMore: response.page.hasMore,
                epoch: response.page.epoch,
                viewMode: 'history',
                oldestPositionAt: response.page.nextBeforeAt,
                oldestPositionSeq: response.page.nextBeforeSeq,
                newestPositionAt: response.page.snapshotHeadAt,
                newestPositionSeq: response.page.snapshotHeadSeq,
                contextNewestAt: contextNewest?.at ?? null,
                contextNewestSeq: contextNewest?.seq ?? null,
                hasMoreNewer: contextNewest !== null
                    && snapshotHead !== null
                    && comparePosition(contextNewest, snapshotHead) < 0,
                requiresLatestReset: true,
                isLoadingMore: false,
                historyVersion: previous.historyVersion + 1,
                warning: null
            })
        }, true)
        return applied
    } catch (error) {
        if (getState(sessionId).olderGeneration !== generation) {
            return false
        }
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            return buildState(previous, {
                isLoadingMore: false,
                warning: error instanceof Error ? error.message : 'Failed to load the searched message'
            })
        }, true)
        return false
    }
}

/**
 * Load one bounded page of messages after a context window's newest row.
 *
 * A search jump leaves the window stranded in the middle of the session: the
 * head is recorded for tail sync, but nothing fills the gap between the two,
 * so scrolling down used to dead-end. This walks that gap forward a page at a
 * time, and reports when the window has finally caught up with the head.
 */
export async function fetchNewerMessages(
    api: ApiClient,
    sessionId: string,
    options: {
        /**
         * Resolves the row the reader is anchored to, read at apply time
         * rather than request time. Forward paging trims from the old end, and
         * the reader can scroll during a slow page — a value captured when the
         * request started would protect the row they have already left.
         */
        resolvePreserveMessageId?: () => string | null
    } = {}
): Promise<NewerLoadOutcome> {
    const initial = getState(sessionId)
    if (initial.isSyncingTail || initial.isLoadingMore) {
        return { kind: 'stopped', reason: 'busy' }
    }
    if (!initial.hasMoreNewer) {
        return { kind: 'stopped', reason: 'exhausted' }
    }
    const after = readPosition(initial.contextNewestAt, initial.contextNewestSeq)
    if (!after) {
        return { kind: 'stopped', reason: 'unavailable' }
    }

    const generation = initial.olderGeneration + 1
    updateState(sessionId, (previous) => buildState(previous, {
        olderGeneration: generation,
        isLoadingMore: true,
        warning: null
    }))

    try {
        const response = await api.getMessages(sessionId, {
            afterAt: after.at,
            afterSeq: after.seq,
            limit: PAGE_SIZE
        })
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        if (initial.epoch !== null && response.page.epoch !== initial.epoch) {
            // The history changed under us; the same authoritative refresh the
            // older path uses also releases the search lock.
            const current = getState(sessionId)
            markMessageWindowForLatestReset(sessionId, current.messages)
            await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
            return { kind: 'stopped', reason: 'epoch-reset' }
        }

        const retained = response.messages.filter(shouldRetainWindowMessage)
        let added = 0
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            const merged = mergeMessages(previous.messages, retained)
            // Trim from the old end: the reader is moving forward, so the
            // newly appended rows are the ones that must survive — unless the
            // reader is anchored in the rows that would go, in which case keep
            // the window longer rather than moving them.
            const preserveMessageId = options.resolvePreserveMessageId?.() ?? null
            const anchorIndex = preserveMessageId
                ? merged.findIndex((message) => (
                    message.id === preserveMessageId
                    || message.localId === preserveMessageId
                ))
                : -1
            const trimLimit = anchorIndex >= 0
                ? Math.max(HISTORY_WINDOW_SIZE, merged.length - anchorIndex)
                : HISTORY_WINDOW_SIZE
            const { kept } = trimPreservingQueued(merged, trimLimit, 'append')
            added = kept.length - previous.messages.length
            // Advance from the page's own boundary rather than the merged
            // window: an SSE row appended at the live head would otherwise
            // look like we had caught up, skipping everything in between.
            const contextNewest = pagePosition(
                response.page.nextAfterAt,
                response.page.nextAfterSeq
            ) ?? derivePosition(retained, 'newest') ?? after
            const oldest = derivePosition(kept, 'oldest')
            // The session can grow after the context was loaded, so trust the
            // head this response reports over the one recorded back then. A
            // page that says there is more is never "caught up", whatever an
            // older head would imply.
            const responseHead = pagePosition(
                response.page.snapshotHeadAt,
                response.page.snapshotHeadSeq
            )
            const recordedHead = readPosition(
                previous.newestPositionAt,
                previous.newestPositionSeq
            )
            const head = responseHead && recordedHead
                ? (comparePosition(responseHead, recordedHead) > 0 ? responseHead : recordedHead)
                : responseHead ?? recordedHead
            const caughtUp = !response.page.hasMore
            return buildState(previous, {
                messages: kept,
                isLoadingMore: false,
                // Trimming the old end means older paging is live again even if
                // the context page had already reached the start.
                hasMore: previous.hasMore || kept.length < merged.length,
                oldestPositionAt: oldest?.at ?? previous.oldestPositionAt,
                oldestPositionSeq: oldest?.seq ?? previous.oldestPositionSeq,
                contextNewestAt: contextNewest?.at ?? previous.contextNewestAt,
                contextNewestSeq: contextNewest?.seq ?? previous.contextNewestSeq,
                // Keep the freshest head so later comparisons do not regress.
                ...(head ? { newestPositionAt: head.at, newestPositionSeq: head.seq } : {}),
                hasMoreNewer: !caughtUp,
                historyVersion: previous.historyVersion + 1,
                warning: null
            })
        }, true)

        const settled = getState(sessionId)
        return settled.hasMoreNewer
            ? { kind: 'loaded', added }
            : { kind: 'caught-up', added }
    } catch (error) {
        if (getState(sessionId).olderGeneration !== generation) {
            return { kind: 'stopped', reason: 'invalidated' }
        }
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            return buildState(previous, {
                isLoadingMore: false,
                warning: error instanceof Error ? error.message : 'Failed to load newer messages'
            })
        }, true)
        return { kind: 'stopped', reason: 'failed' }
    }
}

export function cancelOlderMessageLoad(sessionId: string): void {
    updateState(sessionId, (previous) => {
        if (!previous.isLoadingMore) {
            return previous
        }
        return buildState(previous, {
            olderGeneration: previous.olderGeneration + 1,
            isLoadingMore: false,
            warning: null
        })
    }, true)
}

export function setMessageViewMode(sessionId: string, mode: MessageViewMode): void {
    if (mode === 'tail') {
        messageWindowTargetLocks.delete(sessionId)
    }
    updateState(sessionId, (previous) => {
        if (previous.viewMode === mode) {
            return previous
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
            readThroughRevision: merged.readThroughRevision === undefined ? undefined
                : Math.max(merged.readThroughRevision, ...incoming.map(message => message.contentRevision ?? 0)),
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
    messageWindowTargetLocks.delete(sessionId)
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

function markMessageWindowForLatestReset(sessionId: string, messages: DecryptedMessage[]): void {
    const previous = states.get(sessionId)
    if (!previous) return

    // A rewind/invalidation is authoritative and must refresh even when a
    // historical search target previously paused background tail sync.
    messageWindowTargetLocks.delete(sessionId)
    tailSyncControllers.delete(sessionId)
    clearPersistedState(sessionId)
    setState(sessionId, buildState(previous, {
        messages,
        epoch: null,
        contextNewestAt: null,
        contextNewestSeq: null,
        hasMoreNewer: false,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestPositionAt: null,
        newestPositionSeq: null,
        requiresLatestReset: true,
        preferLatestOnActivation: false,
        isSyncingTail: true,
        isLoadingMore: false,
        warning: null,
        syncGeneration: previous.syncGeneration + 1,
        olderGeneration: previous.olderGeneration + 1
    }), true)
}

/**
 * Mark the current window stale without exposing an empty transcript while a
 * latest snapshot is fetched. The next tail sync sees `requiresLatestReset`
 * and replaces server rows atomically with the authoritative response.
 */
export function invalidateMessageWindow(sessionId: string): void {
    const previous = states.get(sessionId)
    if (!previous) return

    markMessageWindowForLatestReset(sessionId, previous.messages)
}

/**
 * Apply the known local effect of a successful Rewind before the server
 * snapshot arrives. Rewind removes the boundary message and every later row;
 * retaining the earlier prefix keeps the chat usable and lets the current
 * bottom position clamp directly to the new tail.
 */
export function rewindMessageWindow(sessionId: string, messageLocalId: string): void {
    const previous = states.get(sessionId)
    if (!previous) return

    const applied = appliedRewindLocalIds.get(sessionId) ?? new Set<string>()
    if (applied.has(messageLocalId)) return
    applied.add(messageLocalId)
    appliedRewindLocalIds.set(sessionId, applied)

    const boundaryIndex = previous.messages.findIndex((message) => message.localId === messageLocalId)
    if (boundaryIndex < 0) {
        // The boundary may be outside the current latest window. Without a
        // local boundary, retaining rows could show messages removed by the
        // rewind until the authoritative tail sync completes.
        clearMessageWindow(sessionId)
        return
    }

    const messages = previous.messages.slice(0, boundaryIndex)

    markMessageWindowForLatestReset(sessionId, messages)
}

export function seedMessageWindowFromSession(fromSessionId: string, toSessionId: string): void {
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
    const source = getState(fromSessionId)
    const target = getState(toSessionId)
    const seeded = buildState(createState(toSessionId), {
        messages: source.messages.map(message => ({ ...message, contentRevision: undefined })),
        hasMore: source.hasMore,
        tailRevision: source.tailRevision,
        oldestPositionAt: source.oldestPositionAt,
        oldestPositionSeq: source.oldestPositionSeq,
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
    markUnconfirmedDelivery(sessionId, localIds, false)
}

export function markMessagesDispatching(sessionId: string, localIds: string[]): void {
    markUnconfirmedDelivery(sessionId, localIds, true)
}

function markUnconfirmedDelivery(sessionId: string, localIds: string[], dispatching: boolean): void {
    if (localIds.length === 0) return
    const idSet = new Set(localIds)
    updateState(sessionId, (previous) => {
        let changed = false
        const messages = previous.messages.map((message) => {
            if (!message.localId || !idSet.has(message.localId) || typeof message.invokedAt === 'number'
                || (message.deliveryState === 'indeterminate' && Boolean(message.deliveryPending) === dispatching)) return message
            changed = true
            const { deliveryPending: _deliveryPending, ...unconfirmed } = message
            return { ...unconfirmed, deliveryState: 'indeterminate' as const, ...(dispatching ? { deliveryPending: true as const } : {}) }
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
            if (
                !message.localId
                || !idSet.has(message.localId)
                || (message.deliveryState === undefined && message.queueDismissed !== true)
            ) {
                return message
            }
            changed = true
            const {
                deliveryState: _deliveryState,
                deliveryPending: _deliveryPending,
                queueDismissed: _queueDismissed,
                ...requeued
            } = message
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
            const needsClearDismiss = message.queueDismissed === true || message.deliveryState !== undefined || message.deliveryPending === true
            if (!needsStatus && !needsInvokedAt && !needsSteered && !needsClearDismiss) return message
            changed = true
            const { deliveryState: _deliveryState,
                deliveryPending: _deliveryPending, queueDismissed: _queueDismissed, ...withoutClientHold } = message
            return {
                ...withoutClientHold,
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

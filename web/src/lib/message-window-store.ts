import type { ApiClient } from '@/api/client'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage, MessageStatus, MessagesResponse } from '@/types/api'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'

export type MessageViewMode = 'tail' | 'history'

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
    unseenCount: number
    messagesVersion: number
    historyVersion: number
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
    unseenIds: Set<string>
    requiresLatestReset: boolean
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
    epoch: number | null
}

type TailSyncController = {
    api: ApiClient
    running: Promise<void> | null
    trailingRequested: boolean
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
        unseenCount: 0,
        messagesVersion: 0,
        historyVersion: 0,
        oldestPositionAt: null,
        oldestPositionSeq: null,
        newestPositionAt: null,
        newestPositionSeq: null,
        unseenIds: new Set(),
        requiresLatestReset: false,
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
        | 'unseenIds'
        | 'requiresLatestReset'
        | 'syncGeneration'
        | 'olderGeneration'
        | 'historyVersion'
    >>
): InternalState {
    const messages = updates.messages ?? previous.messages
    const unseenIds = updates.unseenIds ?? previous.unseenIds
    const bounds = deriveSeqBounds(messages)
    return {
        ...previous,
        ...updates,
        messages,
        oldestSeq: bounds.oldestSeq,
        newestSeq: bounds.newestSeq,
        unseenIds,
        unseenCount: unseenIds.size,
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

function trimPreservingQueued(
    messages: DecryptedMessage[],
    regularLimit: number,
    mode: 'append' | 'prepend'
): { kept: DecryptedMessage[]; dropped: DecryptedMessage[] } {
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

function unseenIdentity(message: DecryptedMessage): string {
    return message.localId ? `local:${message.localId}` : `id:${message.id}`
}

function collectNewUnseenIds(
    previous: InternalState,
    incoming: DecryptedMessage[]
): Set<string> {
    if (previous.viewMode === 'tail' || incoming.length === 0) {
        return previous.unseenIds
    }
    const representedIds = new Set(previous.messages.map((message) => message.id))
    const representedLocalIds = new Set(
        previous.messages.flatMap((message) => message.localId ? [message.localId] : [])
    )
    const unseenIds = new Set(previous.unseenIds)
    for (const message of incoming) {
        const alreadyRepresented = representedIds.has(message.id)
            || Boolean(message.localId && representedLocalIds.has(message.localId))
        representedIds.add(message.id)
        if (message.localId) representedLocalIds.add(message.localId)
        if (alreadyRepresented || isQueuedForInvocation(message)) continue
        if (normalizeDecryptedMessage(message) === null) continue
        unseenIds.add(unseenIdentity(message))
    }
    return unseenIds
}

function mergeIntoWindow(
    previous: InternalState,
    incoming: DecryptedMessage[],
    options: {
        countUnseen?: boolean
        mode?: 'append' | 'prepend'
        regularLimit?: number
    } = {}
): InternalState {
    if (incoming.length === 0) {
        return previous
    }
    const mode = options.mode ?? (previous.viewMode === 'history' ? 'prepend' : 'append')
    const regularLimit = options.regularLimit
        ?? (previous.viewMode === 'history' ? HISTORY_WINDOW_SIZE : VISIBLE_WINDOW_SIZE)
    const merged = mergeMessages(previous.messages, incoming)
    const { kept, dropped } = trimPreservingQueued(merged, regularLimit, mode)
    let next = buildState(previous, {
        messages: kept,
        unseenIds: options.countUnseen ? collectNewUnseenIds(previous, incoming) : previous.unseenIds
    })
    if (dropped.length === 0) {
        return next
    }
    if (mode === 'append') {
        const oldest = derivePosition(kept, 'oldest')
        return buildState(next, {
            hasMore: true,
            oldestPositionAt: oldest?.at ?? next.oldestPositionAt,
            oldestPositionSeq: oldest?.seq ?? next.oldestPositionSeq
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
    }
): InternalState {
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
    const authoritative = mergeMessages(preserved, response.messages)
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
        unseenIds: collectNewUnseenIds(previous, response.messages),
        requiresLatestReset: false,
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

async function runTailSync(api: ApiClient, sessionId: string): Promise<void> {
    const generation = beginTailSync(sessionId)
    try {
        const initial = getState(sessionId)
        const initialCursor = getNewestCursor(initial)
        const canIncrement = initialCursor !== null
            && initial.epoch !== null
            && !initial.requiresLatestReset

        if (!canIncrement) {
            const requestBaseline = new Map(getState(sessionId).messages.map((message) => [message.id, message]))
            const response = await api.getMessages(sessionId, { limit: PAGE_SIZE })
            if (!isCurrentTailSync(sessionId, generation)) return
            updateState(sessionId, (previous) => {
                if (previous.syncGeneration !== generation) return previous
                return applyLatestResponse(previous, response, {
                    replaceServerRows: initial.requiresLatestReset || response.page.reset,
                    requestBaseline
                })
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
                    countUnseen: previous.viewMode === 'history'
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
            if (current.requiresLatestReset || !response.page.hasMore || !nextAfter) {
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
    const running = runTailSync(controller.api, sessionId)
    controller.running = running
    const finish = () => {
        if (tailSyncControllers.get(sessionId) !== controller || controller.running !== running) {
            return
        }
        controller.running = null
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
    return buildState(previous, {
        messages: kept,
        hasMore: previous.hasMore || dropped.length > 0,
        viewMode: 'tail',
        unseenIds: new Set(),
        epoch: forceLatest ? null : previous.epoch,
        oldestPositionAt: oldest?.at ?? null,
        oldestPositionSeq: oldest?.seq ?? null,
        newestPositionAt: forceLatest ? null : previous.newestPositionAt,
        newestPositionSeq: forceLatest ? null : previous.newestPositionSeq
    })
}

export function activateMessageWindow(sessionId: string): void {
    updateState(sessionId, (previous) => {
        const { kept } = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, 'append')
        const forceLatest = previous.requiresLatestReset
        if (
            previous.viewMode === 'tail'
            && previous.unseenIds.size === 0
            && kept.length === previous.messages.length
            && !forceLatest
        ) {
            return previous
        }
        return enterTailMode(previous)
    }, true)
}

export function syncTailMessages(
    api: ApiClient,
    sessionId: string,
    options: { ensureAfterCurrent?: boolean } = {}
): Promise<void> {
    let controller = tailSyncControllers.get(sessionId)
    if (!controller) {
        controller = { api, running: null, trailingRequested: false }
        tailSyncControllers.set(sessionId, controller)
    }
    controller.api = api
    if (!controller.running) {
        return startTailSync(sessionId, controller)
    }
    const observed = controller.running
    if (!options.ensureAfterCurrent) {
        return observed
    }
    controller.trailingRequested = true
    return waitForTailSyncDrain(sessionId, controller, observed)
}

export async function fetchOlderMessages(api: ApiClient, sessionId: string): Promise<boolean> {
    const initial = getState(sessionId)
    const before = readPosition(initial.oldestPositionAt, initial.oldestPositionSeq)
    if (initial.isSyncingTail || initial.isLoadingMore || !initial.hasMore || !before) {
        return false
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
        if (getState(sessionId).olderGeneration !== generation) return false

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
            return false
        }

        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            const merged = mergeIntoWindow(previous, response.messages, {
                mode: 'prepend',
                regularLimit: OLDER_LOAD_WINDOW_SIZE
            })
            return buildState(merged, {
                hasMore: response.page.hasMore,
                epoch: response.page.epoch,
                oldestPositionAt: response.page.nextBeforeAt,
                oldestPositionSeq: response.page.nextBeforeSeq,
                isLoadingMore: false,
                historyVersion: previous.historyVersion + 1,
                warning: null
            })
        })
        return true
    } catch (error) {
        updateState(sessionId, (previous) => {
            if (previous.olderGeneration !== generation) return previous
            return buildState(previous, {
                isLoadingMore: false,
                warning: error instanceof Error ? error.message : 'Failed to load older messages'
            })
        })
        return false
    }
}

export function setMessageViewMode(sessionId: string, mode: MessageViewMode): void {
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
            countUnseen: previous.viewMode === 'history'
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
            mode: previous.viewMode === 'history' ? 'prepend' : 'append'
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

export function markMessagesConsumed(sessionId: string, localIds: string[], invokedAt: number): void {
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
            if (!needsStatus && !needsInvokedAt) return message
            changed = true
            return {
                ...message,
                ...(needsStatus ? { status: 'sent' as MessageStatus } : {}),
                ...(needsInvokedAt ? { invokedAt } : {})
            }
        })
        if (!changed) return previous
        return buildState(previous, { messages: mergeMessages([], updated) })
    })
}

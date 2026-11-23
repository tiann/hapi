import { useSyncExternalStore } from 'react'
import { EMPTY_READ_STATE, mergeReadState, type SessionReadState, type SessionReadStateRequest } from '@hapi/protocol'
import { randomId } from '@/lib/randomId'

type SessionInput = { id: string; contentRevision?: number; readState?: SessionReadState }
type ReadRequest = Extract<SessionReadStateRequest, { type: 'read' }>
type Pending = { id: string; request: SessionReadStateRequest; onUnreadConflict?: ReadRequest; manualReadFrom?: number }
type Entry = { server: SessionReadState; pending?: Pending }
type Store = Record<string, Entry>
type Sender = (id: string, request: SessionReadStateRequest) => Promise<{ readState: SessionReadState }>
const CHANGE_EVENT = 'hapi.sessionReadState.changed'
const PREFIX = 'hapi.sessionReadState.v1:'
let scope = 'unconfigured'
let sender: Sender | null = null
let changeVersion = 0
let running = false
let retry: ReturnType<typeof setTimeout> | undefined
const tailFollowers = new Map<string, number>()

// The sidebar reads per-session state for every row on every render, and reading
// (let alone parsing) the whole persisted store per row is O(rows x store size).
// localStorage stays the source of truth: the parsed copy is compared with the raw
// stored value on the first read after a microtask checkpoint and trusted for the
// rest of that synchronous pass, so writes from other tabs or other code are
// observed by the next read after the checkpoint.
let cache: { key: string; raw: string | null; store: Store } | null = null
let trusted = false
function trustUntilNextCheckpoint(): void {
    if (trusted) return
    trusted = true
    queueMicrotask(() => { trusted = false })
}
function readStore(key = scope): Store {
    if (trusted && cache?.key === key) return cache.store
    let raw: string | null
    try { raw = localStorage.getItem(PREFIX + key) } catch { return {} }
    if (cache?.key !== key || cache.raw !== raw) {
        let store: Store
        try { store = JSON.parse(raw ?? '{}') as Store } catch { store = {} }
        cache = { key, raw, store }
    }
    trustUntilNextCheckpoint()
    return cache.store
}
function save(store: Store, key = scope): boolean {
    try {
        const raw = JSON.stringify(store)
        localStorage.setItem(PREFIX + key, raw)
        cache = { key, raw, store }
        trustUntilNextCheckpoint()
        return true
    } catch {
        // Callers mutate the cached store before saving; drop it so the next
        // read reflects what is actually persisted.
        cache = null
        trusted = false
        return false
    }
}
function notify(): void {
    changeVersion += 1
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}
function effective(entry?: Entry, incoming?: SessionReadState): SessionReadState {
    const pending = entry?.pending?.request
    const state = mergeReadState(entry?.server, incoming) ?? EMPTY_READ_STATE
    if (!pending) return state
    return {
        ...state,
        readRevision: pending.type === 'read' ? Math.max(state.readRevision, pending.readRevision) : state.readRevision,
        manualUnread: pending.expectedVersion === state.version ? pending.type === 'unread' : state.manualUnread
    }
}

/** Scope includes the authenticated namespace; never re-use another hub's outbox. */
export function configureSessionReadState(key: string, send: Sender): () => void {
    scope = key
    sender = send
    notify()
    void flushSessionReadState()
    const retryNow = () => { void flushSessionReadState() }
    window.addEventListener('online', retryNow)
    window.addEventListener('focus', retryNow)
    return () => {
        window.removeEventListener('online', retryNow)
        window.removeEventListener('focus', retryNow)
        if (sender === send) { sender = null; clearTimeout(retry) }
    }
}

/** Durable operations survive refresh/offline. A stale request is never rebased
 * onto a newer manual choice; only a new viewing action can clear that choice. */
export async function flushSessionReadState(): Promise<void> {
    if (running || !sender) return
    running = true
    const key = scope
    const send = sender
    let failed = false
    try {
        for (const id of Object.keys(readStore(key))) {
            if (sender !== send || scope !== key) break
            // A user or another tab may replace this operation while an
            // earlier session awaits the Hub. Only send the current intent.
            const entry = readStore(key)[id]
            const pending = entry?.pending
            if (!pending) continue
            try {
                const response = await send(id, pending.request)
                const store = readStore(key)
                const current = store[id] ?? entry
                current.server = mergeReadState(current.server, response.readState)!
                if (current.pending?.manualReadFrom !== undefined && pending.request.type === 'read'
                    && response.readState.manualUnread && response.readState.version === current.server.version
                    && response.readState.version === current.pending.request.expectedVersion + 1
                    && response.readState.readRevision > current.pending.manualReadFrom) {
                    // The single intervening write advanced the watermark without
                    // changing the manual flag the newer read intended to clear.
                    current.pending = {
                        ...current.pending, id: randomId(), manualReadFrom: response.readState.readRevision,
                        request: { ...current.pending.request, expectedVersion: response.readState.version }
                    }
                } else if (current.pending?.id === pending.id) delete current.pending
                else if (current.pending?.request.expectedVersion === pending.request.expectedVersion
                    && response.readState.version <= pending.request.expectedVersion + 1
                    && response.readState.manualUnread === (pending.request.type === 'unread')) {
                    // A newer local intent follows our own acknowledged write.
                    // Do not rebase across another client's manual-unread change.
                    current.pending.request.expectedVersion = response.readState.version
                }
                store[id] = current
                if (!save(store, key)) failed = true
                if (scope === key) notify()
            } catch (error) {
                const failure = error as { status?: number; body?: string }
                if ([400, 403, 404, 409].includes(failure.status ?? 0)) {
                    const store = readStore(key)
                    const current = store[id]
                    if (current?.pending?.id === pending.id) {
                        let restore: ReadRequest | undefined
                        // A replacement also returns 409, but never includes readState.
                        try {
                            const body = JSON.parse(failure.body ?? '{}') as { readState?: SessionReadState }
                            current.server = mergeReadState(current.server, body.readState)!
                            const fallback = current.pending.onUnreadConflict
                            if (failure.status === 409 && body.readState && !current.server.manualUnread
                                && fallback && fallback.readRevision > current.server.readRevision) restore = fallback
                        } catch { /* a removed/replaced session has no read state */ }
                        if (restore) current.pending = { id: randomId(), request: restore }
                        else delete current.pending
                        if (!save(store, key)) failed = true
                        if (scope === key) notify()
                    }
                } else {
                    failed = true
                    // One session failing on the Hub must not starve unrelated
                    // receipts. Back off immediately on transport or gateway errors.
                    if (failure.status !== 500) break
                }
            }
        }
    } finally {
        running = false
        clearTimeout(retry)
        if (Object.values(readStore()).some(entry => entry.pending)) {
            retry = setTimeout(() => { void flushSessionReadState() }, failed ? 5_000 : 0)
        }
    }
}

export function observeSessionReadStates(sessions: Iterable<SessionInput>): void {
    const store = readStore()
    let changed = false
    for (const session of sessions) {
        if (!session.readState) continue
        const current = store[session.id]
        const server = mergeReadState(current?.server, session.readState)!
        if (!current || JSON.stringify(current.server) !== JSON.stringify(server)) {
            store[session.id] = { ...current, server }
            changed = true
        }
    }
    if (changed && save(store)) notify()
}

function enqueue(sessionId: string, request: SessionReadStateRequest): void {
    if (!sessionId) return
    const store = readStore()
    const entry = store[sessionId] ?? { server: EMPTY_READ_STATE }
    const previous = entry.pending?.request
    if (request.type === 'read' && previous?.type === 'read') {
        request = { ...request, readRevision: Math.max(request.readRevision, previous.readRevision) }
    }
    const manualReadFrom = request.type === 'read' && entry.server.manualUnread && request.expectedVersion === entry.server.version
        ? entry.server.readRevision : undefined
    store[sessionId] = { ...entry, pending: { id: randomId(), request, manualReadFrom } }
    // Persistence failure must not claim a successful local read.
    if (save(store)) { notify(); void flushSessionReadState() }
}

/** A visible chat following its tail acknowledges output as it renders. Until
 * that lands, hide the session's ordinary dot rather than flash it per message. */
export function followSessionTail(sessionId: string): () => void {
    tailFollowers.set(sessionId, (tailFollowers.get(sessionId) ?? 0) + 1)
    notify()
    return () => {
        const remaining = (tailFollowers.get(sessionId) ?? 1) - 1
        if (remaining > 0) tailFollowers.set(sessionId, remaining)
        else tailFollowers.delete(sessionId)
        notify()
    }
}
/** Display only; running sessions count too. Never acknowledges content. */
export function hasUnseenContent(session: SessionInput, readRevision: number): boolean {
    return !tailFollowers.has(session.id) && (session.contentRevision ?? 0) > readRevision
}

export function getSessionLastSeenAt(sessionId: string): number { return effective(readStore()[sessionId]).readRevision }
export function getSessionManualUnreadAt(sessionId: string, serverState?: SessionReadState): number | null {
    return effective(readStore()[sessionId], serverState).manualUnread ? 0 : null
}
export function getSessionLastSeenSnapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(readStore()).map(([id, entry]) => [id, effective(entry).readRevision]))
}
export function getSessionManualUnreadSnapshot(sessions: readonly SessionInput[] = []): Readonly<Record<string, number | null>> {
    const store = readStore()
    return Object.fromEntries(sessions.map(session => [session.id, effective(store[session.id], session.readState).manualUnread ? 0 : null]))
}
/** A local unread choice can be newer than the Hub version while its write is queued. */
export function pendingUnreadId(sessionId: string): string | undefined {
    const pending = readStore()[sessionId]?.pending
    return pending?.request.type === 'unread' ? pending.id : undefined
}

/** The receipt was already rendered and visible. If a later local unread is
 * in flight, keep its precedence; recover the read only on authoritative conflict. */
export function markRenderedSessionSeen(id: string, revision: number, version: number | undefined, observedUnread: string | undefined): void {
    const store = readStore()
    const pending = store[id]?.pending
    if (pending?.request.type === 'unread' && pending.id !== observedUnread) {
        if (revision > (pending.onUnreadConflict?.readRevision ?? -1)) {
            pending.onUnreadConflict = { type: 'read', readRevision: revision, expectedVersion: version ?? store[id].server.version }
            save(store)
        }
    } else markSessionSeen(id, revision, version)
}

export function sessionNeedsReadAction(session: SessionInput): boolean {
    const state = effective(readStore()[session.id], session.readState)
    return state.manualUnread || (session.contentRevision ?? 0) > state.readRevision
}

export function markListedSessionSeen(session: SessionInput): void {
    observeSessionReadStates([session])
    markSessionSeen(session.id, session.contentRevision ?? 0)
}

export function markSessionSeen(sessionId: string, readRevision: number, observedVersion?: number): void {
    if (!Number.isSafeInteger(readRevision) || readRevision < 0) return
    const entry = readStore()[sessionId]
    const current = effective(entry)
    if (current.readRevision >= readRevision && !current.manualUnread) return
    enqueue(sessionId, { type: 'read', readRevision, expectedVersion: observedVersion ?? entry?.server.version ?? 0 })
}
export function markSessionUnread(sessionId: string, observedState?: SessionReadState): void {
    if (observedState) observeSessionReadStates([{ id: sessionId, readState: observedState }])
    enqueue(sessionId, { type: 'unread', expectedVersion: readStore()[sessionId]?.server.version ?? 0 })
}
export function markAllSessionsSeen(sessions: Iterable<SessionInput>): number {
    const list = [...sessions]
    observeSessionReadStates(list)
    let count = 0
    for (const session of list) {
        const state = effective(readStore()[session.id], session.readState)
        if (state.manualUnread || hasUnseenContent(session, state.readRevision)) {
            markSessionSeen(session.id, session.contentRevision ?? 0)
            count += 1
        }
    }
    return count
}
export function getUnreadSessionCount(sessions: Iterable<SessionInput>): number {
    const store = readStore()
    const unique = new Map([...sessions].map(session => [session.id, session]))
    return [...unique.values()].filter(session => {
        const state = effective(store[session.id], session.readState)
        return state.manualUnread
            || hasUnseenContent(session, Math.max(state.readRevision, session.readState?.readRevision ?? 0))
    }).length
}
function subscribe(listener: () => void): () => void {
    const storage = (event: StorageEvent) => {
        if (event.key === PREFIX + scope || event.key === null) { changeVersion += 1; listener(); void flushSessionReadState() }
    }
    window.addEventListener(CHANGE_EVENT, listener)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener(CHANGE_EVENT, listener); window.removeEventListener('storage', storage) }
}
export function useSessionLastSeenVersion(): number {
    return useSyncExternalStore(subscribe, () => changeVersion, () => 0)
}

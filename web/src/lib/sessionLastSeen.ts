import { useSyncExternalStore } from 'react'
import { EMPTY_READ_STATE, mergeReadState, type SessionReadState, type SessionReadStateRequest } from '@hapi/protocol'

type SessionInput = { id: string; contentRevision?: number; readState?: SessionReadState }
type Pending = { id: string; request: SessionReadStateRequest }
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

function readStore(key = scope): Store {
    try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? '{}') as Store } catch { return {} }
}
function save(store: Store, key = scope): boolean {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(store)); return true } catch { return false }
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
        for (const [id, entry] of Object.entries(readStore(key))) {
            const pending = entry.pending
            if (!pending || sender !== send || scope !== key) continue
            try {
                const response = await send(id, pending.request)
                const store = readStore(key)
                const current = store[id] ?? entry
                current.server = mergeReadState(current.server, response.readState)!
                if (current.pending?.id === pending.id) delete current.pending
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
                        // 409 includes the authoritative manual choice.
                        try {
                            const body = JSON.parse(failure.body ?? '{}') as { readState?: SessionReadState }
                            current.server = mergeReadState(current.server, body.readState)!
                        } catch { /* a removed/replaced session has no read state */ }
                        delete current.pending
                        if (!save(store, key)) failed = true
                        if (scope === key) notify()
                    }
                } else { failed = true; break }
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
    store[sessionId] = { ...entry, pending: { id: crypto.randomUUID(), request } }
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

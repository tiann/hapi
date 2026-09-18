import type { CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredMachine, StoredSession } from '../../../store'
import type { RpcRegistry } from '../../rpcRegistry'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { TerminalRegistry } from '../../terminalRegistry'
import type { CliSocketWithData, SocketServer } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'
import { registerMachineHandlers } from './machineHandlers'
import { registerRpcHandlers } from './rpcHandlers'
import { registerSessionHandlers } from './sessionHandlers'
import { cleanupTerminalHandlers, registerTerminalHandlers } from './terminalHandlers'
import { sessionDeletionEpoch } from '../../../store/sessionInvalidation'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    collaborationMode?: CodexCollaborationMode
}

type SessionEndPayload = {
    sid: string
    time: number
}

type SessionReadyPayload = {
    sid: string
    time: number
}

type MachineAlivePayload = {
    machineId: string
    time: number
}

export type CliHandlersDeps = {
    io: SocketServer
    store: Store
    rpcRegistry: RpcRegistry
    terminalRegistry: TerminalRegistry
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onMachineAlive?: (payload: MachineAlivePayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onAgentProgress?: (sessionId: string, at: number) => void
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    onMessagesConsumed?: (sessionId: string) => void
}

// resolveSessionAccess runs on EVERY cli socket event (message stream deltas,
// keep-alives, consumed acks, terminal output) as the authorization gate. A
// streaming CLI emits dozens of events per second against the same session,
// and each uncached resolution costs a fresh prepared SELECT + metadata JSON
// parse — the dominant hub CPU cost under sustained event traffic (profiled:
// ~40% of a saturated event loop). Positive resolutions for a given session
// are memoized per-socket for this window. Denials stay uncached so clients
// see a fresh outcome on every event while a rename/namespace switch settles.
// The cache is keyed by session id, not a single slot: one runner socket
// multiplexes MANY concurrent sessions (agents driving parallel sessions on
// the same machine), and their events interleave. A single-slot memo thrashes
// to a miss on every event under that interleaving — profiled as seconds-long
// event-loop saturation while message floods alternate session ids — so the
// memo must survive A-B-A event sequences. Bounded by MAX_SESSIONS with
// expired-first then oldest-first eviction (Map preserves insertion order).
// The cached fields callers consume are effectively immutable for a session id
// (namespace) or tolerant of ≤1s staleness (metadata), so the bounded window
// cannot change an access decision that would otherwise differ.
//
// Deletion is the one mutation the TTL window cannot absorb: a memoized grant
// would keep authorizing events (and FK-failing writes) against a row that no
// longer exists. deleteSession bumps a process-wide monotonic epoch; entries
// stamp the epoch they were filled under, and a mismatch forces one
// re-resolve on the next event — an integer compare on the hit path, no DB
// read. Bumps are rare, so the amortized cost is negligible.
const SESSION_ACCESS_CACHE_TTL_MS = 1_000
const SESSION_ACCESS_CACHE_MAX_SESSIONS = 64

export function registerCliHandlers(socket: CliSocketWithData, deps: CliHandlersDeps): void {
    const { io, store, rpcRegistry, terminalRegistry, onSessionAlive, onSessionReady, onSessionEnd, onMachineAlive, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onAgentProgress, onSweepImmediateQueued, onMessagesConsumed } = deps
    const terminalNamespace = io.of('/terminal')
    const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null

    const sessionAccessCache = new Map<string, { access: AccessResult<StoredSession>; expiresAt: number; epoch: number }>()

    const resolveSessionAccess = (sessionId: string, opts?: { fresh?: boolean }): AccessResult<StoredSession> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const now = Date.now()
        // `fresh` bypasses the memo read. Callers that use the resolved
        // session as a write base (e.g. preserving hub-owned metadata keys)
        // must merge against the live row, not a ≤TTL-stale snapshot — a
        // stale base would drop a concurrently-set hub-owned key or
        // resurrect a concurrently-cleared one. A fresh read still
        // write-throughs the cache.
        if (!opts?.fresh) {
            const cached = sessionAccessCache.get(sessionId)
            if (cached && cached.expiresAt > now && cached.epoch === sessionDeletionEpoch()) {
                return cached.access
            }
        }
        const session = store.sessions.getSessionByNamespace(sessionId, namespace)
        let access: AccessResult<StoredSession>
        if (session) {
            access = { ok: true, value: session }
            sessionAccessCache.set(sessionId, { access, expiresAt: now + SESSION_ACCESS_CACHE_TTL_MS, epoch: sessionDeletionEpoch() })
            if (sessionAccessCache.size > SESSION_ACCESS_CACHE_MAX_SESSIONS) {
                for (const [key, entry] of sessionAccessCache) {
                    if (entry.expiresAt <= now) {
                        sessionAccessCache.delete(key)
                    }
                }
                while (sessionAccessCache.size > SESSION_ACCESS_CACHE_MAX_SESSIONS) {
                    const oldest = sessionAccessCache.keys().next().value
                    if (oldest === undefined) break
                    sessionAccessCache.delete(oldest)
                }
            }
        } else {
            sessionAccessCache.delete(sessionId)
            if (store.sessions.getSession(sessionId)) {
                access = { ok: false, reason: 'access-denied' }
            } else {
                access = { ok: false, reason: 'not-found' }
            }
        }
        return access
    }

    const resolveMachineAccess = (machineId: string): AccessResult<StoredMachine> => {
        if (!namespace) {
            return { ok: false, reason: 'namespace-missing' }
        }
        const machine = store.machines.getMachineByNamespace(machineId, namespace)
        if (machine) {
            return { ok: true, value: machine }
        }
        if (store.machines.getMachine(machineId)) {
            return { ok: false, reason: 'access-denied' }
        }
        return { ok: false, reason: 'not-found' }
    }

    const auth = socket.handshake.auth as Record<string, unknown> | undefined
    const sessionId = typeof auth?.sessionId === 'string' ? auth.sessionId : null
    if (sessionId && resolveSessionAccess(sessionId).ok) {
        socket.join(`session:${sessionId}`)
    }

    const machineId = typeof auth?.machineId === 'string' ? auth.machineId : null
    if (machineId && resolveMachineAccess(machineId).ok) {
        socket.join(`machine:${machineId}`)
    }

    const emitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => {
        const message = reason === 'access-denied'
            ? `${scope} access denied`
            : reason === 'not-found'
                ? `${scope} not found`
                : 'Namespace missing'
        socket.emit('error', { message, code: reason, scope, id })
    }

    registerRpcHandlers(socket, rpcRegistry)
    registerSessionHandlers(socket, {
        store,
        resolveSessionAccess,
        emitAccessError,
        onSessionAlive,
        onSessionReady,
        onSessionEnd,
        onWebappEvent,
        onBackgroundTaskDelta,
        onSessionActivity,
        onAgentProgress,
        onSweepImmediateQueued,
        onMessagesConsumed
    })
    registerMachineHandlers(socket, {
        store,
        resolveMachineAccess,
        emitAccessError,
        onMachineAlive,
        onWebappEvent
    })
    registerTerminalHandlers(socket, {
        terminalRegistry,
        terminalNamespace,
        resolveSessionAccess,
        emitAccessError
    })

    socket.on('ping', (callback: () => void) => {
        callback()
    })

    socket.on('disconnect', () => {
        rpcRegistry.unregisterAll(socket)
        cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace })
    })
}

import type { ClientToServerEvents } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { CopilotAgentMode } from '@hapi/protocol'
import type { AgentState, CodexCollaborationMode, Metadata, PermissionMode } from '@hapi/protocol/types'
import { getReasoningStreamId, isRedundantGoalStatusEventContent } from '@hapi/protocol/messages'
import type { Store, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../../sync/todos'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import { extractBackgroundTaskDelta } from '../../../sync/backgroundTasks'
import { shouldRecordSessionActivity } from '../../../sync/sessionActivity'
import type { CliSocketWithData } from '../../socketTypes'
import type { SessionEndReason } from '@hapi/protocol'
import type { AccessErrorReason, AccessResult } from './types'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
}

type SessionEndPayload = {
    sid: string
    time: number
    reason?: SessionEndReason
}

type SessionReadyPayload = {
    sid: string
    time: number
}

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional(),
    // Client-provided origin timestamp (epoch ms) — e.g. a Claude transcript
    // entry's own `timestamp`. Only honored for agent messages (no localId);
    // see addMessage in messages.ts.
    createdAt: z.number().optional()
})

const updateMetadataSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    metadata: z.unknown()
})

const updateStateSchema = z.object({
    sid: z.string(),
    expectedVersion: z.number().int(),
    agentState: z.unknown().nullable()
})

const HUB_OWNED_METADATA_KEYS = ['supersededBySessionId', 'opencodeClearOperation'] as const

function preserveHubOwnedMetadata(incoming: unknown, current: unknown): unknown {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming
    const next = { ...(incoming as Record<string, unknown>) }
    const existing = current && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}
    for (const key of HUB_OWNED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) next[key] = existing[key]
        else delete next[key]
    }
    return next
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionReady?: (payload: SessionReadyPayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    /** Delegates session-end immediate-queue sweep to the MessageService layer. */
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    /** Drops the queued-thinking grace so synchronous CLI handlers (e.g. slash
     *  commands) don't leave the spinner stuck for the full grace window. */
    onMessagesConsumed?: (sessionId: string) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionReady, onSessionEnd, onWebappEvent, onBackgroundTaskDelta, onSessionActivity, onSweepImmediateQueued, onMessagesConsumed } = deps

    socket.on('message', (data: unknown) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sid, localId, createdAt } = parsed.data
        const raw = parsed.data.message

        const content = typeof raw === 'string'
            ? (() => {
                try {
                    return JSON.parse(raw) as unknown
                } catch {
                    return raw
                }
            })()
            : raw

        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            return
        }
        const session = sessionAccess.value

        if (isRedundantGoalStatusEventContent(content)) {
            return
        }

        const msg = store.messages.addMessage(sid, content, localId, undefined, createdAt)

        // A reasoning stream arrives as a series of growing snapshots under one
        // stable id, so a stream should cost one row rather than one per
        // interval. Retire the earlier snapshots only once their replacement is
        // stored: these are separate transactions, and clearing first would let
        // a crash in between take the whole stream. Only rows marked live are
        // eligible, so the settled message that closes a stream survives and
        // also sweeps up its own leftovers.
        const reasoningStreamId = getReasoningStreamId(content)
        if (reasoningStreamId) {
            store.messages.deleteLiveReasoningSnapshots(sid, reasoningStreamId, msg.id)
        }

        if (shouldRecordSessionActivity(content)) {
            onSessionActivity?.(sid, msg.createdAt)
        }

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.sessions.setSessionTodos(sid, todos, msg.createdAt, session.namespace)
            if (updated) {
                const stored = store.sessions.getSession(sid)
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        todos: {
                            version: stored?.todosUpdatedAt ?? msg.createdAt,
                            value: todos
                        },
                        updatedAt: stored?.updatedAt ?? msg.createdAt
                    }
                })
            }
        }

        const teamDelta = extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSession(sid)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            const updated = store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
            if (updated) {
                const stored = store.sessions.getSession(sid)
                // Versioned clear: value null = TeamDelete. Consumers gate on
                // version (store team_state_updated_at) so dual SSE cannot
                // resurrect a deleted team from a lagged older event.
                onWebappEvent?.({
                    type: 'session-updated',
                    sessionId: sid,
                    data: {
                        teamState: {
                            version: stored?.teamStateUpdatedAt ?? msg.createdAt,
                            value: newTeamState
                        },
                        updatedAt: stored?.updatedAt ?? msg.createdAt
                    }
                })
            }
        }

        const bgDelta = extractBackgroundTaskDelta(content)
        if (bgDelta) {
            onBackgroundTaskDelta?.(sid, bgDelta)
        }

        const update = {
            id: randomUUID(),
            seq: msg.seq,
            createdAt: Date.now(),
            body: {
                t: 'new-message' as const,
                sid,
                message: {
                    id: msg.id,
                    seq: msg.seq,
                    createdAt: msg.createdAt,
                    localId: msg.localId,
                    content: msg.content
                }
            }
        }
        socket.to(`session:${sid}`).emit('update', update)

        onWebappEvent?.({
            type: 'message-received',
            sessionId: sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt
            }
        })
    })

    const handleUpdateMetadata: UpdateMetadataHandler = (data, cb) => {
        const parsed = updateMetadataSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, metadata, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionMetadata(
            sid,
            preserveHubOwnedMetadata(metadata, sessionAccess.value.metadata),
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, metadata: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, metadata: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    // Broadcast the persisted (merged) value, not the pre-merge
                    // payload — otherwise other CLIs in the session room would
                    // overwrite their local cache with a tokenless metadata
                    // snapshot even though the DB row was preserved.
                    // See store.sessions.mergeSessionMetadata for the merge
                    // contract.
                    metadata: { version: result.version, value: result.value },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                // The unknown-cast here mirrors the schema's MetadataSchema.nullable()
                // shape: the store returns raw JSON, the wire schema parses it on
                // both ends. Keeping the broadcast shape identical to the socket.io
                // `update-session` body (line ~213) lets the same patch travel
                // through both fan-out channels without divergence.
                data: {
                    metadata: { version: result.version, value: result.value as Metadata | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-metadata', handleUpdateMetadata)

    const handleUpdateState: UpdateStateHandler = (data, cb) => {
        const parsed = updateStateSchema.safeParse(data)
        if (!parsed.success) {
            cb({ result: 'error' })
            return
        }

        const { sid, agentState, expectedVersion } = parsed.data
        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            cb({ result: 'error', reason: sessionAccess.reason })
            return
        }

        const result = store.sessions.updateSessionAgentState(
            sid,
            agentState,
            expectedVersion,
            sessionAccess.value.namespace
        )
        if (result.result === 'success') {
            cb({ result: 'success', version: result.version, agentState: result.value })
        } else if (result.result === 'version-mismatch') {
            cb({ result: 'version-mismatch', version: result.version, agentState: result.value })
        } else {
            cb({ result: 'error' })
        }

        if (result.result === 'success') {
            const stored = store.sessions.getSession(sid)
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: null,
                    agentState: { version: result.version, value: agentState }
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({
                type: 'session-updated',
                sessionId: sid,
                data: {
                    agentState: { version: result.version, value: agentState as AgentState | null },
                    updatedAt: stored?.updatedAt ?? Date.now()
                }
            })
        }
    }

    socket.on('update-state', handleUpdateState)

    socket.on('session-alive', (data: SessionAlivePayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionAlive?.(data)
    })

    socket.on('session-ready', (data: SessionReadyPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionReady?.(data)
    })

    socket.on('messages-consumed', (data: { sid: string; localIds: string[]; clearQueuedThinkingGrace?: boolean; steered?: boolean }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        const invokedAt = Date.now()
        let sessionUpdatedAt: number
        try {
            sessionUpdatedAt = store.recordMessagesConsumed(
                data.sid,
                localIds,
                invokedAt,
                sessionAccess.value.namespace
            )
        } catch (err) {
            console.error('recordMessagesConsumed failed', err)
            return
        }

        try {
            onSessionActivity?.(data.sid, sessionUpdatedAt)
        } catch (err) {
            console.error('onSessionActivity failed', err)
        }

        // Only drop the queued-thinking grace when the CLI explicitly opts in
        // (synchronous handlers like slash commands that will never send
        // their own `thinking=true` keepalive). Normal queue drains still
        // need the grace so the spinner doesn't flicker between the queue
        // shift and `backend.prompt` start.
        if (data.clearQueuedThinkingGrace === true) {
            onMessagesConsumed?.(data.sid)
        }
        // Emit only after the DB transaction succeeds. This is an ACK-level
        // batch contract, so preserve its original timestamp even when IDs are
        // heterogeneous, replayed, or unknown. `steered` is a live-only signal
        // (never persisted) that marks mid-turn delivery for the web badge.
        onWebappEvent?.({ type: 'messages-consumed', sessionId: data.sid, localIds, invokedAt, ...(data.steered === true ? { steered: true } : {}) })
    })

    socket.on('messages-indeterminate', (data: { sid: string; localIds: string[] }) => {
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)) {
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) return
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        try {
            store.recordMessagesIndeterminate(data.sid, localIds, sessionAccess.value.namespace)
        } catch (err) {
            console.error('recordMessagesIndeterminate failed', err)
            return
        }
        onWebappEvent?.({ type: 'messages-indeterminate', sessionId: data.sid, localIds })
    })

    socket.on('messages-steer-state', (
        data: { sid: string; localIds: string[]; state: 'queued' | 'dispatching' },
        ack?: (response: { ok: boolean }) => void
    ) => {
        const reply = typeof ack === 'function' ? ack : () => {}
        if (!data || typeof data.sid !== 'string' || !Array.isArray(data.localIds)
            || (data.state !== 'queued' && data.state !== 'dispatching')) {
            reply({ ok: false })
            return
        }
        const localIds = data.localIds.filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) {
            reply({ ok: false })
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            reply({ ok: false })
            return
        }
        try {
            const ok = store.recordSteerDeliveryState(
                data.sid,
                localIds,
                data.state,
                sessionAccess.value.namespace
            )
            reply({ ok })
            if (ok && data.state === 'queued') {
                onWebappEvent?.({ type: 'messages-requeued', sessionId: data.sid, localIds })
            }
        } catch (err) {
            console.error('recordSteerDeliveryState failed', err)
            reply({ ok: false })
        }
    })

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }

        // Force-invoke only immediate-queued messages (scheduled_at IS NULL) at
        // session end.  *All* scheduled rows — mature or future — are deliberately
        // preserved in DB so the mature-scan path (releaseMatureScheduledMessages)
        // remains the sole emit channel and the CLI ack remains the sole writer of
        // invoked_at.  See HAPI Bot R4: stamping a mature scheduled row here would
        // make the next mature-scan tick skip it (filter on invoked_at IS NULL) and
        // silently drop the user's prompt.
        //
        // Without this sweep for immediate rows, the floating bar would pin queued
        // rows after the CLI exits — there is no longer an ack path, so they would
        // stay queued forever.  The 5-second tick in syncEngine.expireInactive
        // emits scheduled rows when they mature, regardless of session end.
        if (data.reason !== 'cleared') {
            try {
                onSweepImmediateQueued?.(data.sid, Date.now())
            } catch (err) {
                console.error('session-end sweep failed', err)
            }
        }

        onSessionEnd?.(data)
    })
}

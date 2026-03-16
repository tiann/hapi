import type { ClientToServerEvents } from '@hapi/protocol'
import { isObject } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { ModelMode, PermissionMode, TeamState } from '@hapi/protocol/types'
import type { Store, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../../../sync/todos'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type SessionAlivePayload = {
    sid: string
    time: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    modelMode?: ModelMode
}

type SessionEndPayload = {
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
    localId: z.string().optional()
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

/**
 * Sync agentState.requests → teamState.pendingPermissions.
 *
 * In-process teammate agents add permission requests to the parent session's
 * agentState.requests, but never emit a <teammate-message> with type
 * 'permission_request'. This function bridges the gap so that TeamPanel
 * can display permission cards for teammate tools.
 *
 * It also marks teamState permissions as resolved when the corresponding
 * agentState.requests entry is finalized (moved to completedRequests).
 */
function syncAgentPermissionsToTeamState(
    store: Store,
    sid: string,
    namespace: string,
    agentState: unknown,
    onWebappEvent?: (event: SyncEvent) => void
): void {
    const session = store.sessions.getSessionByNamespace(sid, namespace)
    const teamState = session?.teamState as TeamState | null | undefined
    if (!teamState?.members?.length) return

    const stateObj = isObject(agentState) ? agentState : null
    if (!stateObj) return

    const requests = isObject(stateObj.requests) ? stateObj.requests as Record<string, unknown> : {}
    const existingPerms = teamState.pendingPermissions ?? []
    const existingPermIds = new Set(existingPerms.map(p => p.requestId))

    // Determine member name: pick the first active non-lead teammate.
    // If multiple active members, we can't know which one owns the request,
    // so we use a generic label.
    const activeMembers = teamState.members.filter(m =>
        m.status === 'active' && m.name !== 'team-lead'
    )
    const defaultMemberName = activeMembers.length === 1
        ? activeMembers[0].name
        : 'teammate'

    // Add new agentState.requests entries as pending permissions.
    // If a pending permission already exists from a teammate message (with a different requestId
    // like "perm-..."), update its toolUseId to point to the agentState.requests key so the
    // web UI can use RPC-based approval instead of falling back to text messages.
    const newPerms: TeamState['pendingPermissions'] = []
    let hasUpdatedExisting = false
    for (const [requestId, rawReq] of Object.entries(requests)) {
        if (existingPermIds.has(requestId)) continue
        const req = isObject(rawReq) ? rawReq : null
        if (!req) continue

        const toolName = typeof req.tool === 'string' ? req.tool : 'unknown'

        // Check if there's already a pending permission from a teammate message for the same tool
        const existingMatch = existingPerms.find(p =>
            p.status === 'pending' &&
            p.toolName === toolName &&
            p.requestId !== requestId &&
            p.toolUseId !== requestId
        )

        if (existingMatch) {
            // Update existing entry's toolUseId to point to agentState.requests key
            // so the web UI's `perm.toolUseId ?? perm.requestId` picks the correct ID for RPC
            existingMatch.toolUseId = requestId
            hasUpdatedExisting = true
        } else {
            newPerms.push({
                requestId,
                toolUseId: requestId,
                memberName: defaultMemberName,
                toolName,
                description: typeof req.description === 'string' ? req.description : undefined,
                input: req.arguments,
                createdAt: typeof req.createdAt === 'number' ? req.createdAt : Date.now(),
                status: 'pending'
            })
        }
    }

    // Mark permissions as resolved when their request is no longer in agentState.requests.
    // Check both requestId and toolUseId since they may differ (teammate message vs agentState key).
    const requestIds = new Set(Object.keys(requests))
    let hasResolved = false
    const resolvedPerms = existingPerms.map(p => {
        if (p.status === 'pending'
            && !requestIds.has(p.requestId)
            && !(p.toolUseId && requestIds.has(p.toolUseId))) {
            hasResolved = true
            return { ...p, status: 'approved' as const }
        }
        return p
    })

    if (newPerms.length === 0 && !hasResolved && !hasUpdatedExisting) return

    const updatedPerms = hasResolved
        ? [...resolvedPerms, ...newPerms]
        : [...existingPerms, ...newPerms]

    const newTeamState = { ...teamState, pendingPermissions: updatedPerms, updatedAt: Date.now() }
    const updated = store.sessions.setSessionTeamState(sid, newTeamState, Date.now(), namespace)
    if (updated) {
        onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
    }
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onWebappEvent?: (event: SyncEvent) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionEnd, onWebappEvent } = deps

    socket.on('message', (data: unknown) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            return
        }

        const { sid, localId } = parsed.data
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

        const msg = store.messages.addMessage(sid, content, localId)

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.sessions.setSessionTodos(sid, todos, msg.createdAt, session.namespace)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        }

        const teamDelta = extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSessionByNamespace(sid, session.namespace)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            // Guard against accidental team-state wipe:
            // if we only got an incremental update but no existing team state, skip persistence.
            const shouldPersist = !(teamDelta._action === 'update' && !existingTeamState && newTeamState === null)
            const updated = shouldPersist
                ? store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
                : false
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }

            // Auto-approve new teammate permission requests via RPC.
            // Teammate permissions arrive via <teammate-message> and only exist in
            // teamState.pendingPermissions — they never appear in agentState.requests.
            if (teamDelta.pendingPermissions?.length) {
                for (const perm of teamDelta.pendingPermissions) {
                    if (perm.status !== 'pending') continue
                    const rpcId = perm.toolUseId ?? perm.requestId
                    console.log('[teams] auto-approving teammate permission:', perm.memberName, perm.toolName, 'rpcId:', rpcId)
                    socket.timeout(5000).emitWithAck('rpc-request', {
                        method: `${sid}:permission`,
                        params: JSON.stringify({ id: rpcId, approved: true })
                    }).catch((err: Error) => {
                        console.log('[teams] auto-approve RPC failed:', rpcId, err?.message)
                    })
                }
            }
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
                createdAt: msg.createdAt
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
            metadata,
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
            const update = {
                id: randomUUID(),
                seq: Date.now(),
                createdAt: Date.now(),
                body: {
                    t: 'update-session' as const,
                    sid,
                    metadata: { version: result.version, value: metadata },
                    agentState: null
                }
            }
            socket.to(`session:${sid}`).emit('update', update)
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
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
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })

            // Sync agentState.requests to teamState.pendingPermissions.
            // In-process teammate agents have their permission requests added to the
            // parent session's agentState.requests, but no <teammate-message> is emitted
            // so teamState.pendingPermissions never gets populated. Bridge the gap here.
            syncAgentPermissionsToTeamState(
                store, sid, sessionAccess.value.namespace, agentState, onWebappEvent
            )

            // Note: teammate permission auto-approve is handled in the add-message handler
            // when new pendingPermissions arrive via <teammate-message>.
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

    socket.on('session-end', (data: SessionEndPayload) => {
        if (!data || typeof data.sid !== 'string' || typeof data.time !== 'number') {
            return
        }
        const sessionAccess = resolveSessionAccess(data.sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', data.sid, sessionAccess.reason)
            return
        }
        onSessionEnd?.(data)
    })
}

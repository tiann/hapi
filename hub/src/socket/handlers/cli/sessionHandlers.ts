import {
    CODEX_DESKTOP_SYNC_SOURCE,
    DeliveryBatchRequestSchema,
    DeliveryAttemptRequestSchema,
    getExecutionControl,
    isCodexDesktopSyncMessageEnvelope,
    isNativeHapiRunnerSession,
    isObject,
    ManagedSessionOutcomeRequestSchema,
    unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol'
import type { ClientToServerEvents, DeliveryAttemptAck, DeliveryAttemptRequest, DeliveryBatchAck, DeliveryBatchRequest, ManagedSessionOutcomeAck, ManagedSessionOutcomeRequest, SyncMessageAck } from '@hapi/protocol'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { CodexCollaborationMode, CodexServiceTier, PermissionMode } from '@hapi/protocol/types'
import type { Store, StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import { shouldAcceptPassiveSync } from '../../../sync/sessionControlService'
import { extractTodoWriteTodosFromMessageContent } from '../../../sync/todos'
import { extractTeamStateFromMessageContent, applyTeamStateDelta } from '../../../sync/teams'
import { extractBackgroundTaskDelta } from '../../../sync/backgroundTasks'
import { mergeSessionMetadata } from '../../../sync/sessionMetadata'
import type { CliSocketWithData } from '../../socketTypes'
import type { AccessErrorReason, AccessResult } from './types'

type SessionAlivePayload = {
    sid: string
    time: number
    source?: 'cli' | 'codex-desktop-sync'
    generation?: number
    thinking?: boolean
    mode?: 'local' | 'remote'
    permissionMode?: PermissionMode
    model?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: CodexServiceTier | null
    effort?: string | null
    collaborationMode?: CodexCollaborationMode
}

type SessionEndPayload = {
    sid: string
    time: number
    source?: 'cli' | 'codex-desktop-sync'
    generation?: number
}

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>

type EmitAccessError = (scope: 'session' | 'machine', id: string, reason: AccessErrorReason) => void

type UpdateMetadataHandler = ClientToServerEvents['update-metadata']
type UpdateStateHandler = ClientToServerEvents['update-state']
type SyncMessageAckCallback = (answer: SyncMessageAck) => void
type SyncMessageRejectReason = Extract<SyncMessageAck, { inserted: false }>['reason']

const messageSchema = z.object({
    sid: z.string(),
    message: z.union([z.string(), z.unknown()]),
    localId: z.string().optional(),
    source: z.enum(['cli', 'codex-desktop-sync']).optional(),
    generation: z.number().int().min(1).optional()
})

function parseWireMessage(raw: unknown): unknown {
    if (typeof raw !== 'string') {
        return raw
    }
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return raw
    }
}

function markPassiveSyncMessage(content: unknown): unknown {
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return content
    }

    const record = content as Record<string, unknown>
    if (record.role !== 'user' && record.role !== 'agent') {
        return content
    }

    const meta = record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
        ? record.meta as Record<string, unknown>
        : {}

    return {
        ...record,
        meta: {
            ...meta,
            sentFrom: CODEX_DESKTOP_SYNC_SOURCE
        }
    }
}

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

const PASSIVE_SYNC_DEDUPE_LOOKBACK_LIMIT = 200
const PASSIVE_SYNC_AGENT_TEXT_DUPLICATE_WINDOW_MS = 30_000
const PASSIVE_SYNC_READY_DUPLICATE_WINDOW_MS = 10_000
const PASSIVE_SYNC_USER_TEXT_DUPLICATE_WINDOW_MS = 30_000

type AgentTextMessage = {
    message: string
    phase: string | null
}

function normalizeAgentTextForDuplicateCheck(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\n*<oai-mem-citation>[\s\S]*<\/oai-mem-citation>\s*$/, '')
        .trimEnd()
}

function fieldRecord(value: unknown): Record<string, unknown> | null {
    return isObject(value) && !Array.isArray(value) ? value : null
}

function parseAgentTextMessage(content: unknown): AgentTextMessage | null {
    const wrapped = unwrapRoleWrappedRecordEnvelope(content)
    if (!wrapped || wrapped.role !== 'agent') return null

    const codexContent = fieldRecord(wrapped.content)
    if (!codexContent || codexContent.type !== 'codex') return null

    const data = fieldRecord(codexContent.data)
    if (!data || data.type !== 'message' || typeof data.message !== 'string') return null

    return {
        message: normalizeAgentTextForDuplicateCheck(data.message),
        phase: typeof data.phase === 'string' ? data.phase : null
    }
}

function agentTextMessagesEquivalent(leftContent: unknown, rightContent: unknown): boolean {
    const left = parseAgentTextMessage(leftContent)
    const right = parseAgentTextMessage(rightContent)
    if (!left || !right) return false
    if (left.message !== right.message) return false
    if (left.phase === right.phase) return true
    return left.phase === null || right.phase === null
}

function parseUserText(content: unknown): string | null {
    const wrapped = unwrapRoleWrappedRecordEnvelope(content)
    if (!wrapped || wrapped.role !== 'user') return null

    const textContent = fieldRecord(wrapped.content)
    return typeof textContent?.text === 'string' ? textContent.text : null
}

function userTextsEquivalent(leftContent: unknown, rightContent: unknown): boolean {
    const left = parseUserText(leftContent)
    const right = parseUserText(rightContent)
    return left !== null && left === right
}

function isReadyEvent(content: unknown): boolean {
    const wrapped = unwrapRoleWrappedRecordEnvelope(content)
    if (!wrapped || wrapped.role !== 'agent') return false

    const eventContent = fieldRecord(wrapped.content)
    if (!eventContent || eventContent.type !== 'event') return false

    const data = fieldRecord(eventContent.data)
    return data?.type === 'ready'
}

function isWithinWindow(createdAt: number, now: number, windowMs: number): boolean {
    return Number.isFinite(createdAt) && Math.abs(now - createdAt) <= windowMs
}

export type SessionHandlersDeps = {
    store: Store
    resolveSessionAccess: ResolveSessionAccess
    emitAccessError: EmitAccessError
    onSessionAlive?: (payload: SessionAlivePayload) => void
    onSessionEnd?: (payload: SessionEndPayload) => void
    onWebappEvent?: (event: SyncEvent) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
}

export function registerSessionHandlers(socket: CliSocketWithData, deps: SessionHandlersDeps): void {
    const { store, resolveSessionAccess, emitAccessError, onSessionAlive, onSessionEnd, onWebappEvent, onBackgroundTaskDelta } = deps

    socket.on('mark-managed-session-outcome', (raw: ManagedSessionOutcomeRequest, cb: (answer: ManagedSessionOutcomeAck) => void) => {
        const parsed = ManagedSessionOutcomeRequestSchema.safeParse(raw)
        if (!parsed.success) {
            cb({ result: 'error', reason: 'invalid-request' })
            return
        }
        const data = parsed.data
        const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
        if (!namespace || data.namespace !== namespace) {
            cb({ result: 'error', reason: namespace ? 'access-denied' : 'namespace-missing' })
            return
        }
        try {
            const answer = store.managedSessions.markOutcome(data)
            cb(answer)
            if (answer.result === 'success') {
                onWebappEvent?.({ type: 'session-updated', sessionId: answer.canonicalSessionId })
            }
        } catch {
            cb({ result: 'error', reason: 'internal-error' })
        }
    })

    socket.on('record-delivery-attempt', (raw: DeliveryAttemptRequest, cb: (answer: DeliveryAttemptAck) => void) => {
        const parsed = DeliveryAttemptRequestSchema.safeParse(raw)
        if (!parsed.success) {
            cb({ result: 'error', reason: 'invalid-request' })
            return
        }
        const data = parsed.data
        const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
        if (!namespace || data.namespace !== namespace) {
            cb({ result: 'error', reason: namespace ? 'access-denied' : 'namespace-missing' })
            return
        }
        try {
            const canonicalSessionId = store.managedSessions.resolveCanonical(namespace, data.sessionId)
            const session = store.sessions.getSessionByNamespace(canonicalSessionId, namespace)
            if (!session) {
                cb({ result: 'error', reason: 'not-found' })
                return
            }
            const metadata = isObject(session.metadata) ? session.metadata : {}
            const boundMachine = session.machineId ?? (typeof metadata.machineId === 'string' ? metadata.machineId : null)
            if (boundMachine !== data.machineId || metadata.launchNonce !== data.launchNonce) {
                cb({ result: 'error', reason: 'launch-mismatch' })
                return
            }
            const result = store.deliveryAttempts.append({
                idempotencyKey: data.idempotencyKey, namespace, canonicalSessionId, messageId: data.messageId, attemptId: data.attemptId,
                launchNonce: data.launchNonce, sequence: data.sequence, state: data.state, createdAt: data.createdAt
            })
            cb(result.result === 'success'
                ? { result: 'success', canonicalSessionId, state: result.state }
                : { result: 'error', reason: result.reason })
        } catch {
            cb({ result: 'error', reason: 'internal-error' })
        }
    })

    socket.on('prepare-delivery-batch', (raw: DeliveryBatchRequest, cb: (answer: DeliveryBatchAck) => void) => {
        const parsed = DeliveryBatchRequestSchema.safeParse(raw)
        if (!parsed.success) return cb({ result: 'error', reason: 'invalid-request' })
        const attempts = parsed.data.attempts
        const first = attempts[0]
        const namespace = typeof socket.data.namespace === 'string' ? socket.data.namespace : null
        if (!namespace || attempts.some((item) => item.namespace !== namespace)) {
            return cb({ result: 'error', reason: namespace ? 'access-denied' : 'namespace-missing' })
        }
        if (attempts.some((item) => item.machineId !== first.machineId || item.sessionId !== first.sessionId
            || item.launchNonce !== first.launchNonce || item.attemptId !== first.attemptId)) {
            return cb({ result: 'error', reason: 'invalid-request' })
        }
        try {
            const canonicalSessionId = store.managedSessions.resolveCanonical(namespace, first.sessionId)
            const session = store.sessions.getSessionByNamespace(canonicalSessionId, namespace)
            const metadata = session && isObject(session.metadata) ? session.metadata : {}
            const boundMachine = session?.machineId ?? (typeof metadata.machineId === 'string' ? metadata.machineId : null)
            if (!session) return cb({ result: 'error', reason: 'not-found' })
            if (boundMachine !== first.machineId || metadata.launchNonce !== first.launchNonce) {
                return cb({ result: 'error', reason: 'launch-mismatch' })
            }
            const result = store.deliveryAttempts.prepareBatch(attempts.map((item) => ({
                idempotencyKey: item.idempotencyKey,
                namespace,
                canonicalSessionId,
                messageId: item.messageId,
                attemptId: item.attemptId,
                launchNonce: item.launchNonce,
                sequence: item.sequence,
                createdAt: item.createdAt
            })))
            return cb(result.result === 'success'
                ? { result: 'success', canonicalSessionId }
                : { result: 'error', reason: result.reason })
        } catch {
            return cb({ result: 'error', reason: 'internal-error' })
        }
    })

    const rejectPassiveSync = (cb: SyncMessageAckCallback | undefined, reason: SyncMessageRejectReason) => {
        cb?.({ inserted: false, reason })
    }

    const isRecentPassiveSyncDuplicate = (sid: string, content: unknown): boolean => {
        const now = Date.now()
        const recentMessages = store.messages.getMessages(sid, PASSIVE_SYNC_DEDUPE_LOOKBACK_LIMIT)
        return recentMessages.some((message) => {
            if (isCodexDesktopSyncMessageEnvelope(message)) {
                return false
            }

            if (
                agentTextMessagesEquivalent(message.content, content)
                && isWithinWindow(message.createdAt, now, PASSIVE_SYNC_AGENT_TEXT_DUPLICATE_WINDOW_MS)
            ) {
                return true
            }

            if (
                isReadyEvent(message.content)
                && isReadyEvent(content)
                && isWithinWindow(message.createdAt, now, PASSIVE_SYNC_READY_DUPLICATE_WINDOW_MS)
            ) {
                return true
            }

            if (
                userTextsEquivalent(message.content, content)
                && isWithinWindow(message.createdAt, now, PASSIVE_SYNC_USER_TEXT_DUPLICATE_WINDOW_MS)
            ) {
                return true
            }

            return false
        })
    }

    const handleMessage = (
        data: unknown,
        options: { broadcastToCli: boolean; passiveSync: boolean },
        cb?: SyncMessageAckCallback
    ) => {
        const parsed = messageSchema.safeParse(data)
        if (!parsed.success) {
            if (options.passiveSync) {
                rejectPassiveSync(cb, 'metadata-conflict')
            }
            return
        }

        const { sid, localId } = parsed.data
        const parsedContent = parseWireMessage(parsed.data.message)
        const content = options.passiveSync ? markPassiveSyncMessage(parsedContent) : parsedContent

        const sessionAccess = resolveSessionAccess(sid)
        if (!sessionAccess.ok) {
            emitAccessError('session', sid, sessionAccess.reason)
            if (options.passiveSync) {
                rejectPassiveSync(cb, 'metadata-conflict')
            }
            return
        }
        const session = sessionAccess.value

        if (options.passiveSync) {
            const control = getExecutionControl(session.metadata)
            const shouldTrackDesktopOwnership = !isNativeHapiRunnerSession(session.metadata)
            const verdict = shouldTrackDesktopOwnership
                ? shouldAcceptPassiveSync(control, parsed.data.generation, Date.now())
                : { accepted: true, nextControl: control }
            if (!verdict.accepted) {
                rejectPassiveSync(cb, 'stale-generation')
                return
            }

            const needsMirrorSource = shouldTrackDesktopOwnership
                && (!isObject(session.metadata) || session.metadata.mirrorSource !== CODEX_DESKTOP_SYNC_SOURCE)
            const needsExecutionControl = shouldTrackDesktopOwnership
                && verdict.nextControl !== null
                && verdict.nextControl !== control

            if (needsMirrorSource || needsExecutionControl) {
                const metadata = {
                    ...(isObject(session.metadata) ? session.metadata : {}),
                    mirrorSource: CODEX_DESKTOP_SYNC_SOURCE,
                    ...(verdict.nextControl ? { executionControl: verdict.nextControl } : {})
                }
                const result = store.sessions.updateSessionMetadata(
                    sid,
                    metadata,
                    session.metadataVersion,
                    session.namespace,
                    { touchUpdatedAt: false }
                )
                if (result.result !== 'success') {
                    rejectPassiveSync(cb, 'metadata-conflict')
                    return
                }
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

        if (options.passiveSync && isRecentPassiveSyncDuplicate(sid, content)) {
            rejectPassiveSync(cb, 'duplicate')
            return
        }

        const msg = store.messages.addMessage(sid, content, localId)
        const sessionTouched = store.sessions.touchSessionMessage(sid, msg.createdAt, msg.seq, session.namespace)
        if (sessionTouched) {
            onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
        }

        const todos = extractTodoWriteTodosFromMessageContent(content)
        if (todos) {
            const updated = store.sessions.setSessionTodos(sid, todos, msg.createdAt, session.namespace)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
        }

        const teamDelta = extractTeamStateFromMessageContent(content)
        if (teamDelta) {
            const existingSession = store.sessions.getSession(sid)
            const existingTeamState = existingSession?.teamState as import('@hapi/protocol/types').TeamState | null | undefined
            const newTeamState = applyTeamStateDelta(existingTeamState ?? null, teamDelta)
            const updated = store.sessions.setSessionTeamState(sid, newTeamState, msg.createdAt, session.namespace)
            if (updated) {
                onWebappEvent?.({ type: 'session-updated', sessionId: sid, data: { sid } })
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
        if (options.broadcastToCli) {
            socket.to(`session:${sid}`).emit('update', update)
        }

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

        if (options.passiveSync) {
            cb?.({ inserted: true })
        }
    }

    socket.on('message', (data: unknown) => {
        handleMessage(data, { broadcastToCli: true, passiveSync: false })
    })

    socket.on('sync-message', (data: unknown, cb?: SyncMessageAckCallback) => {
        handleMessage(data, { broadcastToCli: false, passiveSync: true }, cb)
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

        const mergedMetadata = mergeSessionMetadata(sessionAccess.value.metadata, metadata)
        const result = store.sessions.updateSessionMetadata(
            sid,
            mergedMetadata,
            expectedVersion,
            sessionAccess.value.namespace,
            { touchUpdatedAt: false }
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
                    metadata: { version: result.version, value: result.value },
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

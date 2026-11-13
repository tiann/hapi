import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CodexCollaborationMode, Metadata, PermissionMode } from '@hapi/protocol/types'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol/modes'
import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { Store, StoredMessage, StoredSession } from '../../../store'
import { ImportedMessageConflictError } from '../../../store/messages'
import { matchAnchored } from './matchAnchored'
import { matchContentPrefix, type ImportCandidate } from './matchContentPrefix'
import type { HubLocalSessionSource } from './sources'

/**
 * Generic local-session importer: owns target lookup, delta
 * computation, atomic persistence, lifecycle metadata and launch config for
 * every flavor. Sources only describe how to match; behavior differences
 * between flavors come from the descriptor, never from flavor branches here.
 */

export type LocalImportLaunchConfig = {
    model?: string | null
    modelReasoningEffort?: string | null
    permissionMode?: PermissionMode | null
    serviceTier?: string | null
    collaborationMode?: CodexCollaborationMode | null
}

export type LocalImportOutcome = {
    sessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

export type LocalImportRequestContext = {
    launch?: LocalImportLaunchConfig
    /** Extra metadata from the request body (Codex preferredPermissionMode). */
    requestMetadata?: Record<string, unknown>
}

const importLocks = new Map<string, Promise<unknown>>()

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function storedMetadata(session: StoredSession): Record<string, unknown> {
    return asRecord(session.metadata) ?? {}
}

export function findImportedLocalSession(options: {
    store: Store
    namespace: string
    machineId: string
    source: HubLocalSessionSource
    nativeId: string
}): StoredSession | null {
    const { store, namespace, machineId, source, nativeId } = options
    const primaryKey = source.nativeIdKeys[0]
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        if (metadata.flavor !== source.flavor
            || metadata.machineId !== machineId
            || metadata[primaryKey] !== nativeId) continue
        return session
    }
    return null
}

function collectImportCandidates(store: Store, namespace: string, engine: SyncEngine | null): ImportCandidate[] {
    const candidatesBySessionId = new Map<string, ImportCandidate>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        candidatesBySessionId.set(session.id, {
            sessionId: session.id,
            active: session.active,
            updatedAt: session.updatedAt,
            metadata: asRecord(session.metadata),
            persisted: true
        })
    }
    for (const session of engine?.getSessionsByNamespace(namespace) ?? []) {
        const existing = candidatesBySessionId.get(session.id)
        candidatesBySessionId.set(session.id, {
            sessionId: session.id,
            active: session.active || Boolean(existing?.active),
            updatedAt: Math.max(session.updatedAt, existing?.updatedAt ?? 0),
            metadata: asRecord(session.metadata) ?? existing?.metadata ?? null,
            persisted: Boolean(existing?.persisted)
        })
    }
    return Array.from(candidatesBySessionId.values())
}

function buildImportMetadata(options: {
    source: HubLocalSessionSource
    transcript: LocalTranscript
    machine: Machine
    existing: Record<string, unknown>
    requestMetadata?: Record<string, unknown>
    importState?: Record<string, unknown>
}): Metadata {
    const { source, transcript, machine, existing, requestMetadata, importState } = options
    const summaryText = transcript.lastUserMessage ?? transcript.title
    const metadata: Record<string, unknown> = {
        ...existing,
        ...requestMetadata,
        path: transcript.cwd ?? (typeof existing.path === 'string' ? existing.path : dirname(transcript.file)),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        // Preserve a HAPI-side rename; only a fresh import names the session.
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText
            ? { text: summaryText, updatedAt: Date.now() }
            : existing.summary,
        machineId: machine.id,
        flavor: source.flavor
    }
    // The primary native id always follows the transcript; alias keys are set
    // only when absent (Codex fork provenance; Claude id history is maintained
    // by the live rotation machinery).
    source.nativeIdKeys.forEach((key, index) => {
        if (index === 0) {
            metadata[key] = transcript.id
            return
        }
        if (typeof existing[key] !== 'string' && !Array.isArray(existing[key])) {
            metadata[key] = transcript.id
        }
    })
    metadata.lifecycleState = typeof existing.lifecycleState === 'string'
        ? existing.lifecycleState
        : source.lifecycleOnCreate
    metadata.lifecycleStateSince = typeof existing.lifecycleStateSince === 'number'
        ? existing.lifecycleStateSince
        : Date.now()
    if (source.lifecycleOnCreate === 'archived') {
        metadata.archivedBy = typeof existing.archivedBy === 'string' ? existing.archivedBy : `${source.flavor}-import`
        metadata.archiveReason = typeof existing.archiveReason === 'string'
            ? existing.archiveReason
            : `Imported from local ${source.displayName} history`
    }
    if (importState && source.importStateKey) metadata[source.importStateKey] = importState
    return metadata as Metadata
}

function updateMetadataWithRetry(
    store: Store,
    sessionId: string,
    namespace: string,
    transform: (metadata: Record<string, unknown>) => Metadata
): Metadata {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = store.sessions.getSessionByNamespace(sessionId, namespace)
        if (!current) throw new Error('Imported HAPI session disappeared')
        const next = transform(storedMetadata(current))
        const result = store.sessions.updateSessionMetadata(
            sessionId,
            next,
            current.metadataVersion,
            namespace,
            { touchUpdatedAt: false }
        )
        if (result.result === 'success') return next
        if (result.result === 'error') throw new Error('Failed to persist local import metadata')
    }
    throw new Error('Local import metadata changed concurrently')
}

function emitImportedMessages(engine: SyncEngine, sessionId: string, messages: StoredMessage[]): void {
    for (const message of messages) {
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                localId: message.localId,
                content: message.content,
                createdAt: message.createdAt,
                invokedAt: message.invokedAt
            }
        })
    }
}

function buildImportState(source: HubLocalSessionSource, transcript: LocalTranscript, machineId: string, state: string, startedAt: number, error?: string): Record<string, unknown> {
    return {
        state,
        machineId,
        [source.nativeIdKeys[0]]: transcript.id,
        sourceFile: transcript.file,
        startedAt,
        updatedAt: Date.now(),
        leafEntryId: transcript.cursor ?? null,
        ...(error !== undefined ? { error } : {})
    }
}

/** History locators for fork/rewind: persisted user messages with a native anchor. */
function buildHistoryLocators(transcript: LocalTranscript, persistedLocalIds: Set<string>): {
    entryIds: Record<string, string>
    points: Record<string, true>
} | null {
    const entryIds: Record<string, string> = {}
    for (const message of transcript.messages) {
        if (message.content.role !== 'user' || !message.historyPoint) continue
        if (!persistedLocalIds.has(message.id)) continue
        entryIds[message.id] = message.historyPoint
    }
    if (Object.keys(entryIds).length === 0) return null
    const points: Record<string, true> = {}
    for (const localId of Object.keys(entryIds)) points[localId] = true
    return { entryIds, points }
}

export async function importLocalTranscript(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    source: HubLocalSessionSource
    transcript: LocalTranscript
    machine: Machine
    request?: LocalImportRequestContext
    existingSession?: StoredSession | null
}): Promise<LocalImportOutcome> {
    const { store, engine, namespace, source, transcript, machine } = options
    const request = options.request ?? {}
    const importPrefix = `${source.flavor}:${transcript.id}:`
    const lockKey = `${namespace}:${machine.id}:${source.flavor}:${transcript.id}`
    const startedAt = Date.now()
    const cursorKey = source.match.strategy === 'anchored' ? source.match.cursorKey : undefined

    const run = async (): Promise<LocalImportOutcome> => {
        let target = options.existingSession === undefined
            ? findImportedLocalSession({ store, namespace, machineId: machine.id, source, nativeId: transcript.id })
            : options.existingSession
        let touchedSessionId = target?.id ?? null
        let created = false

        // Mark an existing session as importing before touching messages so
        // concurrent list reads observe the in-flight state.
        if (source.importStateKey && target) {
            updateMetadataWithRetry(store, target.id, namespace, (metadata) => buildImportMetadata({
                source,
                transcript,
                machine,
                existing: metadata,
                requestMetadata: request.requestMetadata,
                importState: buildImportState(source, transcript, machine.id, 'importing', startedAt)
            }))
        }

        const finishErrorState = (outcome: LocalImportOutcome, state: 'diverged' | 'failed'): LocalImportOutcome => {
            if (source.importStateKey && touchedSessionId) {
                try {
                    updateMetadataWithRetry(store, touchedSessionId, namespace, (metadata) => buildImportMetadata({
                        source,
                        transcript,
                        machine,
                        existing: metadata,
                        requestMetadata: request.requestMetadata,
                        importState: buildImportState(source, transcript, machine.id, state, startedAt, outcome.error?.message)
                    }))
                    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: touchedSessionId! })
                } catch {}
            }
            return outcome
        }

        try {
            // --- match ----------------------------------------------------
            let delta: LocalTranscript['messages']
            if (source.match.strategy === 'contentPrefix') {
                const candidates = collectImportCandidates(store, namespace, engine)
                const result = matchContentPrefix({
                    candidates,
                    transcript,
                    nativeIdKeys: [...source.nativeIdKeys],
                    sourceMachineId: machine.id,
                    compareKey: source.match.compareKey,
                    getAllMessages: (sessionId) => store.messages.getAllMessages(sessionId)
                })
                if (result.status === 'session_active') {
                    return finishErrorState({
                        sessionId: transcript.id,
                        error: { code: 'session_active', message: result.message }
                    }, 'failed')
                }
                if (result.targetSessionId) {
                    const resolved = store.sessions.getSessionByNamespace(result.targetSessionId, namespace)
                    if (!resolved) throw new Error('Imported HAPI session disappeared')
                    target = resolved
                    touchedSessionId = resolved.id
                } else {
                    target = null
                }
                delta = transcript.messages.slice(result.deltaStartIndex)
            } else {
                const match = matchAnchored({
                    storedMessages: target ? store.messages.getAllMessages(target.id) : [],
                    transcript,
                    importPrefix,
                    cursor: target && cursorKey
                        ? (typeof storedMetadata(target)[cursorKey] === 'string' ? storedMetadata(target)[cursorKey] as string : null)
                        : null
                })
                if (match.status !== 'ok') {
                    return finishErrorState({
                        sessionId: transcript.id,
                        ...(target ? { hapiSessionId: target.id } : {}),
                        error: { code: match.status, message: match.message }
                    }, match.status === 'already_in_hapi' ? 'failed' : 'diverged')
                }
                delta = match.delta
            }

            // R6: never interleave into a live session.
            if (target?.active && delta.length > 0) {
                return finishErrorState({
                    sessionId: transcript.id,
                    hapiSessionId: target.id,
                    appended: 0,
                    error: {
                        code: 'session_active',
                        message: `The HAPI ${source.displayName} session is active; stop it before importing native history changes`
                    }
                }, 'failed')
            }

            // --- persist (atomic) -----------------------------------------
            const committed = store.runInTransaction(() => {
                let stored: StoredSession
                if (target) {
                    const current = store.sessions.getSessionByNamespace(target.id, namespace)
                    if (!current) throw new Error('Imported HAPI session disappeared')
                    stored = current
                } else {
                    const requestModel = request.launch?.model
                    const transcriptModel = transcript.launch?.model
                    const createModel = requestModel !== undefined ? (requestModel ?? undefined) : (transcriptModel ?? undefined)
                    const metadata = buildImportMetadata({
                        source,
                        transcript,
                        machine,
                        existing: {},
                        requestMetadata: request.requestMetadata,
                        ...(source.importStateKey
                            ? { importState: buildImportState(source, transcript, machine.id, 'importing', startedAt) }
                            : {})
                    })
                    stored = store.sessions.getOrCreateSession(
                        source.match.strategy === 'contentPrefix'
                            ? randomUUID()
                            : `${source.flavor}-import:${machine.id}:${transcript.id}`,
                        metadata,
                        {},
                        namespace,
                        createModel,
                        transcript.launch?.effort ?? undefined
                    )
                    created = true
                    touchedSessionId = stored.id
                }

                const importedAt = Date.now()
                const appended: StoredMessage[] = []
                for (const message of delta) {
                    const result = store.messages.addImportedMessage(
                        stored.id,
                        message.content,
                        message.id,
                        message.createdAt ?? importedAt
                    )
                    if (result.inserted) appended.push(result.message)
                }

                const persistedLocalIds = new Set(store.messages.getAllMessages(stored.id)
                    .map((message) => message.localId)
                    .filter((localId): localId is string => Boolean(localId)))
                updateMetadataWithRetry(store, stored.id, namespace, (metadata) => {
                    const next = buildImportMetadata({
                        source,
                        transcript,
                        machine,
                        existing: metadata,
                        requestMetadata: request.requestMetadata,
                        ...(source.importStateKey
                            ? { importState: buildImportState(source, transcript, machine.id, 'complete', startedAt) }
                            : {})
                    })
                    const locators = buildHistoryLocators(transcript, persistedLocalIds)
                    if (locators) {
                        next.conversationHistoryEntryIds = locators.entryIds
                        next.conversationHistoryPoints = locators.points
                    }
                    if (cursorKey && transcript.cursor) {
                        next[cursorKey] = transcript.cursor
                    }
                    return next
                })

                return {
                    hapiSessionId: stored.id,
                    appended,
                    action: created ? 'created' as const : appended.length > 0 ? 'updated' as const : 'unchanged' as const
                }
            })

            // --- post-commit (same lock) ----------------------------------
            const hapiSessionId = committed.hapiSessionId
            // Transcript launch hints land on the session only when the import
            // created it: getOrCreateSession already applied them at creation,
            // and reapplying them on a re-import would clobber a HAPI-side
            // model/effort change. Request keys win afterwards below.
            if (committed.action === 'created') {
                if (transcript.launch?.model !== undefined) {
                    store.sessions.setSessionModel(hapiSessionId, transcript.launch.model, namespace, { touchUpdatedAt: false })
                }
                if (transcript.launch?.effort !== undefined) {
                    store.sessions.setSessionEffort(hapiSessionId, transcript.launch.effort, namespace, { touchUpdatedAt: false })
                }
            }
            const launch = request.launch ?? {}
            const config: Parameters<SyncEngine['applySessionConfig']>[1] = {}
            if (Object.prototype.hasOwnProperty.call(launch, 'model')) config.model = launch.model
            if (Object.prototype.hasOwnProperty.call(launch, 'modelReasoningEffort')) config.modelReasoningEffort = launch.modelReasoningEffort
            if (Object.prototype.hasOwnProperty.call(launch, 'permissionMode')) {
                const mode = (launch.permissionMode ?? 'default') as PermissionMode
                // Unknown modes fail the flavor check and are ignored here; the
                // route validates user input before reaching the importer.
                if (isPermissionModeAllowedForFlavor(mode, source.flavor)) {
                    config.permissionMode = mode
                }
            }
            if (Object.prototype.hasOwnProperty.call(launch, 'serviceTier')) config.serviceTier = launch.serviceTier
            if (Object.prototype.hasOwnProperty.call(launch, 'collaborationMode') && launch.collaborationMode !== null) {
                config.collaborationMode = launch.collaborationMode
            }
            let outcome: LocalImportOutcome = {
                sessionId: transcript.id,
                hapiSessionId,
                action: committed.action,
                appended: committed.appended.length
            }
            if (Object.keys(config).length > 0) {
                try {
                    await engine.applySessionConfig(hapiSessionId, config)
                } catch (error) {
                    outcome = {
                        ...outcome,
                        error: {
                            code: 'config_failed',
                            message: error instanceof Error ? error.message : 'Failed to apply launch config'
                        }
                    }
                }
            }

            const activityAt = committed.appended.at(-1)?.createdAt ?? transcript.modifiedAt
            engine.recordSessionActivity(hapiSessionId, activityAt)
            emitImportedMessages(engine, hapiSessionId, committed.appended)
            engine.handleRealtimeEvent({ type: 'session-updated', sessionId: hapiSessionId })
            return outcome
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to persist imported local history'
            const code = error instanceof ImportedMessageConflictError ? 'transcript_diverged' : 'import_failed'
            const surviving = touchedSessionId
                ? store.sessions.getSessionByNamespace(touchedSessionId, namespace)
                : null
            if (source.importStateKey && surviving) {
                try {
                    updateMetadataWithRetry(store, surviving.id, namespace, (metadata) => buildImportMetadata({
                        source,
                        transcript,
                        machine,
                        existing: metadata,
                        requestMetadata: request.requestMetadata,
                        importState: buildImportState(source, transcript, machine.id, code === 'transcript_diverged' ? 'diverged' : 'failed', startedAt, message)
                    }))
                    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: surviving.id })
                } catch {}
            }
            return {
                sessionId: transcript.id,
                ...(surviving ? { hapiSessionId: surviving.id } : {}),
                error: { code, message }
            }
        }
    }

    // Serialize imports per namespace:machine:flavor:native id. The second
    // concurrent caller runs after the first and observes an empty delta.
    const prior = importLocks.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const current = prior.catch(() => {}).then(() => gate)
    importLocks.set(lockKey, current)
    await prior.catch(() => {})
    try {
        return await run()
    } finally {
        release()
        if (importLocks.get(lockKey) === current) importLocks.delete(lockKey)
    }
}
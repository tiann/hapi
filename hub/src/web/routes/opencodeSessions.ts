import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import type { OpencodeLocalSessionSummary, OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol/modes'
import type { PermissionMode } from '@hapi/protocol/modes'
import type { Metadata } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const importLocks = new Map<string, Promise<OpencodeImportResult>>()

export type OpencodeSessionListItem = OpencodeLocalSessionSummary & {
    hapiSessionId?: string
}

export type OpencodeImportResult = {
    opencodeSessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function storedMetadata(session: StoredSession): Record<string, unknown> {
    return asRecord(session.metadata) ?? {}
}

function resolveOpencodeMachine(
    engine: SyncEngine | null,
    namespace: string,
    requestedMachineId?: string | null
): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) return online.find((machine) => machine.id === requestedMachineId) ?? null
    return online[0] ?? null
}

function importedOpencodeSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const importedByOpencodeId = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const opencodeSessionId = metadata.opencodeSessionId
        if (metadata.flavor !== 'opencode'
            || metadata.machineId !== machineId
            || typeof opencodeSessionId !== 'string'
            || importedByOpencodeId.has(opencodeSessionId)) continue
        importedByOpencodeId.set(opencodeSessionId, session)
    }
    return importedByOpencodeId
}

function findImportedOpencodeSession(
    store: Store,
    namespace: string,
    machineId: string,
    opencodeSessionId: string
): StoredSession | null {
    return importedOpencodeSessionsById(store, namespace, machineId).get(opencodeSessionId) ?? null
}

function buildOpencodeMetadata(
    transcript: OpencodeLocalSessionWithMessages,
    machine: Machine,
    existing: Record<string, unknown>
): Metadata {
    const summaryText = transcript.lastUserMessage ?? transcript.title
    return {
        ...existing,
        path: transcript.cwd ?? (typeof existing.path === 'string' ? existing.path : dirname(transcript.file)),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText ? { text: summaryText, updatedAt: Date.now() } : undefined,
        machineId: machine.id,
        flavor: 'opencode',
        opencodeSessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'opencode-import',
        archiveReason: typeof existing.archiveReason === 'string' ? existing.archiveReason : 'Imported from local OpenCode history'
    }
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
        if (result.result === 'error') throw new Error('Failed to persist OpenCode import metadata')
    }
    throw new Error('OpenCode import metadata changed concurrently')
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

function classifyImportDelta(
    existing: StoredMessage[],
    transcript: OpencodeLocalSessionWithMessages
): { messages: OpencodeLocalSessionWithMessages['messages']; error?: string } {
    const sourceByLocalId = new Map(transcript.messages.map((message) => [
        message.localId,
        truncateOversizedMessageContent(message.content)
    ]))
    const sourceIds = transcript.messages.map((message) => message.localId)
    const storedImported = existing
        .filter((message) => message.localId?.startsWith(importedPrefix(transcript.id)))
    for (let index = 0; index < storedImported.length; index += 1) {
        if (sourceIds[index] !== storedImported[index]!.localId) {
            return { messages: [], error: `Local OpenCode transcript changed or dropped imported entry ${storedImported[index]!.localId}` }
        }
    }
    for (const message of storedImported) {
        const source = sourceByLocalId.get(message.localId!)
        if (!source || !isDeepStrictEqual(source, message.content)) {
            return { messages: [], error: `Local OpenCode transcript changed or dropped imported entry ${message.localId}` }
        }
    }
    const imported = new Set(storedImported.map((message) => message.localId!))
    const delta = transcript.messages.filter((message) => !imported.has(message.localId))
    if (existing.length > storedImported.length && delta.length > 0) {
        return { messages: [], error: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages' }
    }
    return { messages: delta }
}

function importedPrefix(sessionId: string): string {
    return `opencode:${sessionId}:`
}

export function importOpencodeSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: OpencodeLocalSessionWithMessages
    existingSession?: StoredSession | null
}): OpencodeImportResult {
    const { store, engine, namespace, machine, transcript, existingSession } = options
    let stored = existingSession === undefined
        ? findImportedOpencodeSession(store, namespace, machine.id, transcript.id)
        : existingSession
    const created = !stored
    if (!stored) {
        const metadata = buildOpencodeMetadata(transcript, machine, {})
        stored = store.sessions.getOrCreateSession(
            `opencode-import:${machine.id}:${transcript.id}`,
            metadata,
            {},
            namespace
        )
    } else {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildOpencodeMetadata(transcript, machine, metadata))
    }

    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript)
    if (delta.error) {
        return {
            opencodeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'transcript_diverged', message: delta.error }
        }
    }
    if (stored.active && delta.messages.length > 0) {
        const message = 'The HAPI OpenCode session is active; stop it before importing native history changes'
        return {
            opencodeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'session_active', message }
        }
    }

    const appended: StoredMessage[] = []
    try {
        for (const source of delta.messages) {
            const result = store.messages.addImportedMessage(stored.id, source.content, source.localId, source.createdAt)
            if (result.inserted) appended.push(result.message)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist imported OpenCode history'
        const code = error instanceof ImportedMessageConflictError ? 'transcript_diverged' : 'import_failed'
        return { opencodeSessionId: transcript.id, hapiSessionId: stored.id, error: { code, message } }
    }

    try {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildOpencodeMetadata(transcript, machine, metadata))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to finalize imported OpenCode history'
        return { opencodeSessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'import_failed', message } }
    }
    const activityAt = appended.at(-1)?.createdAt ?? transcript.modifiedAt
    engine.recordSessionActivity(stored.id, activityAt)
    emitImportedMessages(engine, stored.id, appended)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        opencodeSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appended.length > 0 ? 'updated' : 'unchanged',
        appended: appended.length
    }
}

async function importWithLock(key: string, work: () => OpencodeImportResult): Promise<OpencodeImportResult> {
    const prior = importLocks.get(key)
    if (prior) return prior
    const current = Promise.resolve().then(work)
    importLocks.set(key, current)
    try {
        return await current
    } finally {
        if (importLocks.get(key) === current) importLocks.delete(key)
    }
}

export function createOpencodeSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/opencode/sessions', async (c) => {
        const namespace = c.get('namespace')
        const machine = resolveOpencodeMachine(options.getSyncEngine(), namespace, c.req.query('machineId')?.trim() || null)
        if (!machine) return c.json({ success: false, error: 'No online machine available for OpenCode history import', sessions: [] }, 503)
        const result = await options.getSyncEngine()!.listOpencodeSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success) return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        const importedByOpencodeId = importedOpencodeSessionsById(options.store, namespace, machine.id)
        const sessions: OpencodeSessionListItem[] = result.sessions.map((summary) => {
            const imported = importedByOpencodeId.get(summary.id)
            return {
                ...summary,
                ...(imported ? { hapiSessionId: imported.id } : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/opencode/import-sessions', async (c) => {
        const body = asRecord(await c.req.json().catch(() => null))
        const sessionIds = Array.isArray(body?.sessionIds)
            ? body.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
            : []
        if (sessionIds.length === 0) return c.json({ success: false, error: 'No OpenCode sessions selected', results: [] }, 400)
        const uniqueSessionIds = [...new Set(sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveOpencodeMachine(engine, namespace, typeof body?.machineId === 'string' ? body.machineId.trim() : null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for OpenCode history import', results: [] }, 503)
        const remote = await engine.listOpencodeSessionsForMachine(
            machine.id,
            typeof body?.cwd === 'string' ? body.cwd.trim() : null,
            uniqueSessionIds
        )
        if (!remote.success) return c.json({ success: false, error: remote.error, results: [], machineId: machine.id }, 503)
        const byId = new Map(remote.sessions
            .filter((session): session is OpencodeLocalSessionWithMessages => 'messages' in session)
            .map((session) => [session.id, session]))
        const importedByOpencodeId = importedOpencodeSessionsById(options.store, namespace, machine.id)
        const requestedModel = typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null
        const requestedModelReasoningEffort = typeof body?.modelReasoningEffort === 'string' && body.modelReasoningEffort.trim().length > 0
            ? body.modelReasoningEffort.trim()
            : null
        const requestedPermissionMode = typeof body?.permissionMode === 'string' && body.permissionMode.trim().length > 0
            ? body.permissionMode.trim()
            : null
        if (requestedPermissionMode && !isPermissionModeAllowedForFlavor(requestedPermissionMode as PermissionMode, 'opencode')) {
            return c.json({ success: false, error: 'Invalid permission mode for OpenCode sessions', results: [] }, 400)
        }
        type LaunchConfig = Parameters<SyncEngine['applySessionConfig']>[1]
        const launchConfig: LaunchConfig = {}
        const hasLaunchKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(body ?? {}, key)
        // Property presence matters: applySessionConfig only resets a persisted
        // value when the key is present, so explicit nulls / 'default' must be
        // preserved to clear stale selections on re-import.
        if (hasLaunchKey('model')) launchConfig.model = requestedModel
        if (hasLaunchKey('modelReasoningEffort')) launchConfig.modelReasoningEffort = requestedModelReasoningEffort
        if (requestedPermissionMode) launchConfig.permissionMode = requestedPermissionMode as PermissionMode
        const results: OpencodeImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const transcript = byId.get(sessionId)
            if (!transcript) {
                results.push({ opencodeSessionId: sessionId, error: { code: 'not_found', message: 'OpenCode session transcript not found' } })
                continue
            }
            const result = await importWithLock(`${namespace}:${machine.id}:${sessionId}`, () => importOpencodeSession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript,
                existingSession: importedByOpencodeId.get(sessionId) ?? null
            }))
            if (!result.error && result.hapiSessionId && Object.keys(launchConfig).length > 0) {
                // The transcript is already persisted here; a config failure
                // must stay scoped to this session's result instead of turning
                // into an unstructured 500 that aborts the rest of a bulk run.
                try {
                    await engine.applySessionConfig(result.hapiSessionId, launchConfig)
                } catch (error) {
                    result.error = {
                        code: 'config_failed',
                        message: error instanceof Error ? error.message : 'Failed to apply OpenCode launch config'
                    }
                }
            }
            results.push(result)
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}

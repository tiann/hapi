import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import type { PiLocalSessionSummary, PiLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const importLocks = new Map<string, Promise<PiImportResult>>()

export type PiSessionListItem = PiLocalSessionSummary & {
    hapiSessionId?: string
    importState?: 'importing' | 'complete' | 'failed' | 'diverged'
}

export type PiImportResult = {
    piSessionId: string
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

function resolvePiMachine(
    engine: SyncEngine | null,
    namespace: string,
    requestedMachineId?: string | null
): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) return online.find((machine) => machine.id === requestedMachineId) ?? null
    return online[0] ?? null
}

function findImportedPiSession(
    store: Store,
    namespace: string,
    machineId: string,
    piSessionId: string
): StoredSession | null {
    return importedPiSessionsById(store, namespace, machineId).get(piSessionId) ?? null
}

function importedPiSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const importedByPiId = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const piSessionId = metadata.piSessionId
        if (metadata.flavor !== 'pi'
            || metadata.machineId !== machineId
            || typeof piSessionId !== 'string'
            || importedByPiId.has(piSessionId)) continue
        importedByPiId.set(piSessionId, session)
    }
    return importedByPiId
}

function buildPiMetadata(
    transcript: PiLocalSessionWithMessages,
    machine: Machine,
    existing: Record<string, unknown>,
    state: NonNullable<Metadata['piImportState']>
): Metadata {
    const summaryText = transcript.lastUserMessage ?? transcript.title
    const entryIds = asRecord(existing.conversationHistoryEntryIds) ?? {}
    const points = asRecord(existing.conversationHistoryPoints) ?? {}
    return {
        ...existing,
        path: transcript.cwd ?? (typeof existing.path === 'string' ? existing.path : dirname(transcript.file)),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText ? { text: summaryText, updatedAt: Date.now() } : undefined,
        machineId: machine.id,
        flavor: 'pi',
        piSessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'pi-import',
        archiveReason: typeof existing.archiveReason === 'string' ? existing.archiveReason : 'Imported from local Pi history',
        conversationHistoryEntryIds: entryIds as Record<string, string>,
        conversationHistoryPoints: points as Record<string, true>,
        piImportState: state
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
        if (result.result === 'error') throw new Error('Failed to persist Pi import metadata')
    }
    throw new Error('Pi import metadata changed concurrently')
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

function importedPrefix(sessionId: string): string {
    return `pi:${sessionId}:`
}

function classifyImportDelta(
    existing: StoredMessage[],
    transcript: PiLocalSessionWithMessages,
    observedLeafId: string | null
): { messages: PiLocalSessionWithMessages['messages']; error?: string } {
    const sourceLocalIds = transcript.messages.map((message) => message.localId)
    const sourceIndexByLocalId = new Map(sourceLocalIds.map((localId, index) => [localId, index]))
    const storedImported = existing
        .filter((message) => message.localId?.startsWith(importedPrefix(transcript.id)))
    let priorSourceIndex = -1
    for (const message of storedImported) {
        const sourceIndex = sourceIndexByLocalId.get(message.localId!)
        if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
            return { messages: [], error: 'Local Pi transcript no longer extends the previously imported history' }
        }
        priorSourceIndex = sourceIndex
    }
    const sourceByLocalId = new Map(transcript.messages.map((message) => [
        message.localId,
        truncateOversizedMessageContent(message.content)
    ]))
    const changed = storedImported.find((message) => !isDeepStrictEqual(sourceByLocalId.get(message.localId!), message.content))
    if (changed?.localId) {
        return { messages: [], error: `Local Pi transcript changed imported entry ${changed.localId}` }
    }
    if (!observedLeafId) {
        const imported = new Set(storedImported.map((message) => message.localId!))
        return { messages: transcript.messages.filter((message) => !imported.has(message.localId)) }
    }
    const leafIndex = transcript.activeEntryIds.indexOf(observedLeafId)
    if (leafIndex === -1) {
        return { messages: [], error: 'The active Pi branch no longer contains the last imported entry' }
    }
    const newEntryIds = new Set(transcript.activeEntryIds.slice(leafIndex + 1))
    return { messages: transcript.messages.filter((message) => newEntryIds.has(message.entryId)) }
}

function markImportState(
    store: Store,
    engine: SyncEngine,
    sessionId: string,
    namespace: string,
    transcript: PiLocalSessionWithMessages,
    machineId: string,
    state: 'failed' | 'diverged',
    error: string
): void {
    const current = store.sessions.getSessionByNamespace(sessionId, namespace)
    const currentImportState = asRecord(asRecord(current?.metadata)?.piImportState)
    const startedAt = typeof currentImportState?.startedAt === 'number' ? currentImportState.startedAt : Date.now()
    updateMetadataWithRetry(store, sessionId, namespace, (metadata) => ({
        ...metadata,
        path: typeof metadata.path === 'string' ? metadata.path : (transcript.cwd ?? dirname(transcript.file)),
        host: typeof metadata.host === 'string' ? metadata.host : machineId,
        piImportState: {
            state,
            machineId,
            piSessionId: transcript.id,
            sourceFile: transcript.file,
            startedAt,
            updatedAt: Date.now(),
            leafEntryId: transcript.leafEntryId ?? null,
            error
        }
    } as Metadata))
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId })
}

export function importPiSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: PiLocalSessionWithMessages
    existingSession?: StoredSession | null
}): PiImportResult {
    const { store, engine, namespace, machine, transcript, existingSession } = options
    const startedAt = Date.now()
    let stored = existingSession === undefined
        ? findImportedPiSession(store, namespace, machine.id, transcript.id)
        : existingSession
    const created = !stored
    if (!stored) {
        const metadata = buildPiMetadata(transcript, machine, {}, {
            state: 'importing',
            machineId: machine.id,
            piSessionId: transcript.id,
            sourceFile: transcript.file,
            startedAt,
            updatedAt: startedAt,
            leafEntryId: transcript.leafEntryId ?? null
        })
        stored = store.sessions.getOrCreateSession(
            `pi-import:${machine.id}:${transcript.id}`,
            metadata,
            {},
            namespace,
            transcript.model ?? undefined,
            transcript.thinkingLevel ?? undefined
        )
    } else {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => buildPiMetadata(transcript, machine, metadata, {
            state: 'importing',
            machineId: machine.id,
            piSessionId: transcript.id,
            sourceFile: transcript.file,
            startedAt,
            updatedAt: startedAt,
            leafEntryId: transcript.leafEntryId ?? null
        }))
    }

    const currentMetadata = storedMetadata(store.sessions.getSessionByNamespace(stored.id, namespace) ?? stored)
    const observedLeafId = typeof currentMetadata.piHistoryLeafEntryId === 'string'
        ? currentMetadata.piHistoryLeafEntryId
        : null
    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript, observedLeafId)
    if (delta.error) {
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'diverged', delta.error)
        return { piSessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'transcript_diverged', message: delta.error } }
    }
    if (stored.active && delta.messages.length > 0) {
        const message = 'The HAPI Pi session is active; stop it before importing native history changes'
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'failed', message)
        return { piSessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'session_active', message } }
    }

    const appended: StoredMessage[] = []
    try {
        for (const source of delta.messages) {
            const result = store.messages.addImportedMessage(stored.id, source.content, source.localId, source.createdAt)
            if (result.inserted) appended.push(result.message)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist imported Pi history'
        const state = error instanceof ImportedMessageConflictError ? 'diverged' : 'failed'
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, state, message)
        return {
            piSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: state === 'diverged' ? 'transcript_diverged' : 'import_failed', message }
        }
    }

    const persistedLocalIds = new Set(store.messages.getAllMessages(stored.id)
        .map((message) => message.localId)
        .filter((localId): localId is string => Boolean(localId)))
    try {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) => {
            const entryIds = { ...(asRecord(metadata.conversationHistoryEntryIds) ?? {}) } as Record<string, string>
            const points = { ...(asRecord(metadata.conversationHistoryPoints) ?? {}) } as Record<string, true>
            for (const source of transcript.messages) {
                if (source.content.role !== 'user' || !persistedLocalIds.has(source.localId)) continue
                entryIds[source.localId] = source.entryId
                points[source.localId] = true
            }
            return {
                ...buildPiMetadata(transcript, machine, metadata, {
                    state: 'complete',
                    machineId: machine.id,
                    piSessionId: transcript.id,
                    sourceFile: transcript.file,
                    startedAt,
                    updatedAt: Date.now(),
                    leafEntryId: transcript.leafEntryId ?? null
                }),
                conversationHistoryEntryIds: entryIds,
                conversationHistoryPoints: points,
                ...(transcript.leafEntryId ? { piHistoryLeafEntryId: transcript.leafEntryId } : {})
            }
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to finalize imported Pi history'
        try { markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'failed', message) } catch {}
        return { piSessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'import_failed', message } }
    }
    if (transcript.model !== undefined) store.sessions.setSessionModel(stored.id, transcript.model ?? null, namespace, { touchUpdatedAt: false })
    if (transcript.thinkingLevel !== undefined) store.sessions.setSessionEffort(stored.id, transcript.thinkingLevel ?? null, namespace, { touchUpdatedAt: false })
    const activityAt = appended.at(-1)?.createdAt ?? transcript.modifiedAt
    engine.recordSessionActivity(stored.id, activityAt)
    emitImportedMessages(engine, stored.id, appended)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        piSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appended.length > 0 ? 'updated' : 'unchanged',
        appended: appended.length
    }
}

async function importWithLock(key: string, work: () => PiImportResult): Promise<PiImportResult> {
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

export function createPiSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/pi/sessions', async (c) => {
        const namespace = c.get('namespace')
        const machine = resolvePiMachine(options.getSyncEngine(), namespace, c.req.query('machineId')?.trim() || null)
        if (!machine) return c.json({ success: false, error: 'No online machine available for Pi history import', sessions: [] }, 503)
        const result = await options.getSyncEngine()!.listPiSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success) return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        const importedByPiId = importedPiSessionsById(options.store, namespace, machine.id)
        const sessions: PiSessionListItem[] = result.sessions.map((summary) => {
            const imported = importedByPiId.get(summary.id)
            const metadata = imported ? storedMetadata(imported) : null
            const importState = asRecord(metadata?.piImportState)?.state
            return {
                ...summary,
                ...(imported ? { hapiSessionId: imported.id } : {}),
                ...(importState === 'importing' || importState === 'complete' || importState === 'failed' || importState === 'diverged'
                    ? { importState }
                    : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/pi/import-sessions', async (c) => {
        const body = asRecord(await c.req.json().catch(() => null))
        const sessionIds = Array.isArray(body?.sessionIds)
            ? body.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
            : []
        if (sessionIds.length === 0) return c.json({ success: false, error: 'No Pi sessions selected', results: [] }, 400)
        const uniqueSessionIds = [...new Set(sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolvePiMachine(engine, namespace, typeof body?.machineId === 'string' ? body.machineId.trim() : null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for Pi history import', results: [] }, 503)
        const remote = await engine.listPiSessionsForMachine(
            machine.id,
            typeof body?.cwd === 'string' ? body.cwd.trim() : null,
            uniqueSessionIds
        )
        if (!remote.success) return c.json({ success: false, error: remote.error, results: [], machineId: machine.id }, 503)
        const byId = new Map(remote.sessions
            .filter((session): session is PiLocalSessionWithMessages => 'messages' in session)
            .map((session) => [session.id, session]))
        const importedByPiId = importedPiSessionsById(options.store, namespace, machine.id)
        const results: PiImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const transcript = byId.get(sessionId)
            if (!transcript) {
                results.push({ piSessionId: sessionId, error: { code: 'not_found', message: 'Pi session transcript not found' } })
                continue
            }
            results.push(await importWithLock(`${namespace}:${machine.id}:${sessionId}`, () => importPiSession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript,
                existingSession: importedByPiId.get(sessionId) ?? null
            })))
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}

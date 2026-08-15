import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import type { DshLocalSessionSummary, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const importLocks = new Map<string, Promise<DshImportResult>>()

export type DshSessionListItem = DshLocalSessionSummary & {
    hapiSessionId?: string
    importState?: 'importing' | 'complete' | 'failed' | 'diverged'
}

export type DshImportResult = {
    dshSessionId: string
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

function resolveDshMachine(
    engine: SyncEngine | null,
    namespace: string,
    requestedMachineId?: string | null
): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) return online.find((machine) => machine.id === requestedMachineId) ?? null
    return online[0] ?? null
}

function importedDshSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const imported = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const dshSessionId = metadata.dshSessionId
        if (metadata.flavor !== 'dsh'
            || metadata.machineId !== machineId
            || typeof dshSessionId !== 'string'
            || imported.has(dshSessionId)) continue
        imported.set(dshSessionId, session)
    }
    return imported
}

function buildDshMetadata(
    transcript: DshLocalSessionWithMessages,
    machine: Machine,
    sourceUrl: string,
    existing: Record<string, unknown>,
    state: NonNullable<Metadata['dshImportState']>
): Metadata {
    const summaryText = transcript.lastUserMessage ?? transcript.title
    const liveEventSeq = typeof existing.dshHistoryLastEventSeq === 'number'
        ? existing.dshHistoryLastEventSeq
        : undefined
    const completeEventSeq = transcript.lastEventSeq === null
        ? liveEventSeq
        : liveEventSeq === undefined
            ? transcript.lastEventSeq
            : Math.max(liveEventSeq, transcript.lastEventSeq)
    return {
        ...existing,
        path: transcript.cwd
            ?? (typeof existing.path === 'string' ? existing.path : machine.metadata?.homeDir ?? process.cwd()),
        host: typeof existing.host === 'string' ? existing.host : (machine.metadata?.host ?? machine.id),
        os: typeof existing.os === 'string' ? existing.os : (machine.metadata?.platform ?? process.platform),
        name: typeof existing.name === 'string' ? existing.name : transcript.title,
        summary: summaryText ? { text: summaryText, updatedAt: Date.now() } : undefined,
        machineId: machine.id,
        flavor: 'dsh',
        dshSessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'dsh-import',
        archiveReason: typeof existing.archiveReason === 'string'
            ? existing.archiveReason
            : 'Imported from DeepSeek Harness history',
        dshHistoryLastEventSeq: state.state === 'complete'
            ? completeEventSeq
            : liveEventSeq,
        dshImportState: {
            ...state,
            sourceUrl,
            ...(state.state === 'complete' ? { lastEventSeq: completeEventSeq } : {})
        }
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
        if (result.result === 'error') throw new Error('Failed to persist DeepSeek Harness import metadata')
    }
    throw new Error('DeepSeek Harness import metadata changed concurrently')
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
    return `dsh:${sessionId}:`
}

function classifyImportDelta(
    existing: StoredMessage[],
    transcript: DshLocalSessionWithMessages,
    observedEventSeq: number | null
): { messages: DshLocalSessionWithMessages['messages']; error?: string } {
    const sourceIndexByLocalId = new Map(transcript.messages.map((message, index) => [message.localId, index]))
    const storedImported = existing.filter((message) => message.localId?.startsWith(importedPrefix(transcript.id)))
    let priorSourceIndex = -1
    for (const message of storedImported) {
        const sourceIndex = sourceIndexByLocalId.get(message.localId!)
        if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
            return { messages: [], error: 'DeepSeek Harness history no longer extends the previously imported transcript' }
        }
        priorSourceIndex = sourceIndex
    }

    const sourceByLocalId = new Map(transcript.messages.map((message) => [
        message.localId,
        truncateOversizedMessageContent(message.content)
    ]))
    const changed = storedImported.find((message) => !isDeepStrictEqual(sourceByLocalId.get(message.localId!), message.content))
    if (changed?.localId) {
        return { messages: [], error: `DeepSeek Harness history changed imported event ${changed.localId}` }
    }

    const importedIds = new Set(storedImported.map((message) => message.localId!))
    return {
        messages: transcript.messages.filter((message) =>
            !importedIds.has(message.localId)
            && (observedEventSeq === null || message.eventSeq > observedEventSeq)
        )
    }
}

function markImportState(options: {
    store: Store
    engine: SyncEngine
    sessionId: string
    namespace: string
    transcript: DshLocalSessionWithMessages
    machineId: string
    sourceUrl: string
    state: 'failed' | 'diverged'
    error: string
}): void {
    const current = options.store.sessions.getSessionByNamespace(options.sessionId, options.namespace)
    const currentState = asRecord(asRecord(current?.metadata)?.dshImportState)
    const startedAt = typeof currentState?.startedAt === 'number' ? currentState.startedAt : Date.now()
    updateMetadataWithRetry(options.store, options.sessionId, options.namespace, (metadata) => ({
        ...metadata,
        path: typeof metadata.path === 'string' ? metadata.path : (options.transcript.cwd ?? process.cwd()),
        host: typeof metadata.host === 'string' ? metadata.host : options.machineId,
        dshImportState: {
            state: options.state,
            machineId: options.machineId,
            dshSessionId: options.transcript.id,
            sourceUrl: options.sourceUrl,
            startedAt,
            updatedAt: Date.now(),
            lastEventSeq: options.transcript.lastEventSeq,
            error: options.error
        }
    } as Metadata))
    options.engine.handleRealtimeEvent({ type: 'session-updated', sessionId: options.sessionId })
}

export function importDshSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    sourceUrl: string
    transcript: DshLocalSessionWithMessages
    existingSession?: StoredSession | null
}): DshImportResult {
    const { store, engine, namespace, machine, sourceUrl, transcript, existingSession } = options
    const startedAt = Date.now()
    let stored = existingSession === undefined
        ? importedDshSessionsById(store, namespace, machine.id).get(transcript.id) ?? null
        : existingSession
    const created = !stored
    const priorMetadata = stored ? storedMetadata(stored) : {}
    const observedEventSeq = typeof priorMetadata.dshHistoryLastEventSeq === 'number'
        ? priorMetadata.dshHistoryLastEventSeq
        : null
    const importingState: NonNullable<Metadata['dshImportState']> = {
        state: 'importing',
        machineId: machine.id,
        dshSessionId: transcript.id,
        sourceUrl,
        startedAt,
        updatedAt: startedAt,
        lastEventSeq: transcript.lastEventSeq
    }

    if (!stored) {
        stored = store.sessions.getOrCreateSession(
            `dsh-import:${machine.id}:${transcript.id}`,
            buildDshMetadata(transcript, machine, sourceUrl, {}, importingState),
            {},
            namespace,
            transcript.model ?? undefined,
            undefined,
            transcript.reasoningEffort ?? undefined
        )
    } else {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) =>
            buildDshMetadata(transcript, machine, sourceUrl, metadata, importingState))
    }

    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript, observedEventSeq)
    if (delta.error) {
        markImportState({ store, engine, sessionId: stored.id, namespace, transcript, machineId: machine.id, sourceUrl, state: 'diverged', error: delta.error })
        return {
            dshSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'transcript_diverged', message: delta.error }
        }
    }
    if (stored.active && delta.messages.length > 0) {
        const message = 'The HAPI DeepSeek Harness session is active; stop it before importing history changes'
        markImportState({ store, engine, sessionId: stored.id, namespace, transcript, machineId: machine.id, sourceUrl, state: 'failed', error: message })
        return {
            dshSessionId: transcript.id,
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
        const message = error instanceof Error ? error.message : 'Failed to persist DeepSeek Harness history'
        const state = error instanceof ImportedMessageConflictError ? 'diverged' : 'failed'
        markImportState({ store, engine, sessionId: stored.id, namespace, transcript, machineId: machine.id, sourceUrl, state, error: message })
        return {
            dshSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: state === 'diverged' ? 'transcript_diverged' : 'import_failed', message }
        }
    }

    try {
        updateMetadataWithRetry(store, stored.id, namespace, (latest) => buildDshMetadata(
            transcript,
            machine,
            sourceUrl,
            latest,
            {
                state: 'complete',
                machineId: machine.id,
                dshSessionId: transcript.id,
                sourceUrl,
                startedAt,
                updatedAt: Date.now(),
                lastEventSeq: transcript.lastEventSeq
            }
        ))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to finalize DeepSeek Harness history import'
        try {
            markImportState({ store, engine, sessionId: stored.id, namespace, transcript, machineId: machine.id, sourceUrl, state: 'failed', error: message })
        } catch {}
        return { dshSessionId: transcript.id, hapiSessionId: stored.id, error: { code: 'import_failed', message } }
    }

    if (transcript.model !== undefined) {
        store.sessions.setSessionModel(stored.id, transcript.model ?? null, namespace, { touchUpdatedAt: false })
    }
    if (transcript.reasoningEffort !== undefined) {
        store.sessions.setSessionModelReasoningEffort(
            stored.id,
            transcript.reasoningEffort ?? null,
            namespace,
            { touchUpdatedAt: false }
        )
    }
    engine.recordSessionActivity(stored.id, appended.at(-1)?.createdAt ?? transcript.modifiedAt)
    emitImportedMessages(engine, stored.id, appended)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        dshSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appended.length > 0 ? 'updated' : 'unchanged',
        appended: appended.length
    }
}

async function importWithLock(key: string, work: () => DshImportResult): Promise<DshImportResult> {
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

export function createDshSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/dsh/sessions', async (c) => {
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveDshMachine(engine, namespace, c.req.query('machineId')?.trim() || null)
        if (!engine || !machine) {
            return c.json({ success: false, error: 'No online machine available for DeepSeek Harness import', sessions: [] }, 503)
        }
        const result = await engine.listDshSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success) {
            return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        }
        const imported = importedDshSessionsById(options.store, namespace, machine.id)
        const sessions: DshSessionListItem[] = result.sessions.map((summary) => {
            const hapiSession = imported.get(summary.id)
            const importState = asRecord(hapiSession ? storedMetadata(hapiSession).dshImportState : null)?.state
            return {
                ...summary,
                ...(hapiSession ? { hapiSessionId: hapiSession.id } : {}),
                ...(importState === 'importing' || importState === 'complete' || importState === 'failed' || importState === 'diverged'
                    ? { importState }
                    : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/dsh/import-sessions', async (c) => {
        const body = asRecord(await c.req.json().catch(() => null))
        const sessionIds = Array.isArray(body?.sessionIds)
            ? body.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
            : []
        if (sessionIds.length === 0) {
            return c.json({ success: false, error: 'No DeepSeek Harness sessions selected', results: [] }, 400)
        }
        const uniqueSessionIds = [...new Set(sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveDshMachine(
            engine,
            namespace,
            typeof body?.machineId === 'string' ? body.machineId.trim() : null
        )
        if (!engine || !machine) {
            return c.json({ success: false, error: 'No online machine available for DeepSeek Harness import', results: [] }, 503)
        }
        const remote = await engine.listDshSessionsForMachine(
            machine.id,
            typeof body?.cwd === 'string' ? body.cwd.trim() : null,
            uniqueSessionIds
        )
        if (!remote.success) {
            return c.json({ success: false, error: remote.error, results: [], machineId: machine.id }, 503)
        }
        const byId = new Map(remote.sessions
            .filter((session): session is DshLocalSessionWithMessages => 'messages' in session)
            .map((session) => [session.id, session]))
        const imported = importedDshSessionsById(options.store, namespace, machine.id)
        const results: DshImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const transcript = byId.get(sessionId)
            if (!transcript) {
                results.push({
                    dshSessionId: sessionId,
                    error: { code: 'not_found', message: 'DeepSeek Harness session history not found' }
                })
                continue
            }
            results.push(await importWithLock(`${namespace}:${machine.id}:${sessionId}`, () => importDshSession({
                store: options.store,
                engine,
                namespace,
                machine,
                sourceUrl: remote.sourceUrl,
                transcript,
                existingSession: imported.get(sessionId) ?? null
            })))
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}

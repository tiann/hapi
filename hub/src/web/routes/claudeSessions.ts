import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Hono } from 'hono'
import type { ClaudeLocalSessionSummary, ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import type { Metadata } from '@hapi/protocol/types'
import type { Store, StoredMessage, StoredSession } from '../../store'
import { ImportedMessageConflictError } from '../../store/messages'
import { truncateOversizedMessageContent } from '../../store/contentCodec'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const importLocks = new Map<string, Promise<ClaudeImportResult>>()

export type ClaudeSessionListItem = ClaudeLocalSessionSummary & {
    hapiSessionId?: string
    importState?: 'importing' | 'complete' | 'failed' | 'diverged'
}

export type ClaudeImportResult = {
    claudeSessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
}

type ClaudeImportLaunchSettings = {
    model?: string | null
    effort?: string | null
    permissionMode?: 'default' | 'bypassPermissions'
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseLaunchSettings(body: Record<string, unknown>): ClaudeImportLaunchSettings | null {
    const settings: ClaudeImportLaunchSettings = {}
    for (const key of ['model', 'effort'] as const) {
        if (!Object.prototype.hasOwnProperty.call(body, key)) continue
        const value = body[key]
        if (value !== null && typeof value !== 'string') return null
        settings[key] = typeof value === 'string' ? value.trim() || null : null
    }
    if (Object.prototype.hasOwnProperty.call(body, 'permissionMode')) {
        if (body.permissionMode !== 'default' && body.permissionMode !== 'bypassPermissions') return null
        settings.permissionMode = body.permissionMode
    }
    return settings
}

function storedMetadata(session: StoredSession): Record<string, unknown> {
    return asRecord(session.metadata) ?? {}
}

function resolveClaudeMachine(engine: SyncEngine | null, namespace: string, requestedMachineId?: string | null): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) return online.find((machine) => machine.id === requestedMachineId) ?? null
    return online[0] ?? null
}

function importedClaudeSessionsById(store: Store, namespace: string, machineId: string): Map<string, StoredSession> {
    const imported = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        const claudeSessionId = metadata.claudeSessionId
        if (
            metadata.flavor !== 'claude' ||
            metadata.machineId !== machineId ||
            typeof claudeSessionId !== 'string' ||
            imported.has(claudeSessionId)
        )
            continue
        imported.set(claudeSessionId, session)
    }
    return imported
}

function buildClaudeMetadata(
    transcript: ClaudeLocalSessionWithMessages,
    machine: Machine,
    existing: Record<string, unknown>,
    state: NonNullable<Metadata['claudeImportState']>,
    launchSettings: ClaudeImportLaunchSettings
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
        flavor: 'claude',
        claudeSessionId: transcript.id,
        lifecycleState: typeof existing.lifecycleState === 'string' ? existing.lifecycleState : 'archived',
        lifecycleStateSince: typeof existing.lifecycleStateSince === 'number' ? existing.lifecycleStateSince : Date.now(),
        archivedBy: typeof existing.archivedBy === 'string' ? existing.archivedBy : 'claude-import',
        archiveReason: typeof existing.archiveReason === 'string' ? existing.archiveReason : 'Imported from local Claude history',
        ...(launchSettings.permissionMode !== undefined
            ? { preferredPermissionMode: launchSettings.permissionMode }
            : {}),
        claudeImportState: state
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
        const result = store.sessions.updateSessionMetadata(sessionId, next, current.metadataVersion, namespace, { touchUpdatedAt: false })
        if (result.result === 'success') return next
        if (result.result === 'error') throw new Error('Failed to persist Claude import metadata')
    }
    throw new Error('Claude import metadata changed concurrently')
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
    return `claude:${sessionId}:`
}

function nativeClaudeLocalId(message: StoredMessage, sessionId: string): string | null {
    const envelope = asRecord(message.content)
    const output = asRecord(envelope?.content)
    const event = asRecord(output?.data)
    if (envelope?.role !== 'agent' || output?.type !== 'output' || typeof event?.uuid !== 'string') return null
    return `${importedPrefix(sessionId)}${event.uuid}`
}

function classifyImportDelta(
    existing: StoredMessage[],
    transcript: ClaudeLocalSessionWithMessages
): { messages: ClaudeLocalSessionWithMessages['messages']; error?: string } {
    const sourceIndexByLocalId = new Map(transcript.messages.map((message, index) => [message.localId, index]))
    const storedImported = existing.filter((message) => message.localId?.startsWith(importedPrefix(transcript.id)))
    let priorSourceIndex = -1
    for (const message of storedImported) {
        const sourceIndex = sourceIndexByLocalId.get(message.localId!)
        if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
            return {
                messages: [],
                error: 'Local Claude transcript no longer extends the previously imported history'
            }
        }
        priorSourceIndex = sourceIndex
    }

    const sourceByLocalId = new Map(
        transcript.messages.map((message) => [message.localId, truncateOversizedMessageContent(message.content)])
    )
    const changed = storedImported.find((message) => !isDeepStrictEqual(sourceByLocalId.get(message.localId!), message.content))
    if (changed?.localId) {
        return {
            messages: [],
            error: `Local Claude transcript changed imported entry ${changed.localId}`
        }
    }

    const imported = new Set(storedImported.map((message) => message.localId!))
    let observedSourceIndex = priorSourceIndex
    for (const message of existing) {
        const localId = message.localId?.startsWith(importedPrefix(transcript.id))
            ? message.localId
            : nativeClaudeLocalId(message, transcript.id)
        if (!localId) continue
        const sourceIndex = sourceIndexByLocalId.get(localId)
        if (sourceIndex !== undefined) observedSourceIndex = Math.max(observedSourceIndex, sourceIndex)
    }
    return {
        messages: transcript.messages.filter((message, index) => index > observedSourceIndex && !imported.has(message.localId))
    }
}

function markImportState(
    store: Store,
    engine: SyncEngine,
    sessionId: string,
    namespace: string,
    transcript: ClaudeLocalSessionWithMessages,
    machineId: string,
    state: 'failed' | 'diverged',
    error: string
): void {
    const current = store.sessions.getSessionByNamespace(sessionId, namespace)
    const currentState = asRecord(asRecord(current?.metadata)?.claudeImportState)
    const startedAt = typeof currentState?.startedAt === 'number' ? currentState.startedAt : Date.now()
    updateMetadataWithRetry(
        store,
        sessionId,
        namespace,
        (metadata) =>
            ({
                ...metadata,
                path: typeof metadata.path === 'string' ? metadata.path : (transcript.cwd ?? dirname(transcript.file)),
                host: typeof metadata.host === 'string' ? metadata.host : machineId,
                claudeImportState: {
                    state,
                    machineId,
                    claudeSessionId: transcript.id,
                    sourceFile: transcript.file,
                    startedAt,
                    updatedAt: Date.now(),
                    error
                }
            }) as Metadata
    )
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId })
}

export function importClaudeSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: ClaudeLocalSessionWithMessages
    existingSession?: StoredSession | null
    launchSettings?: ClaudeImportLaunchSettings
}): ClaudeImportResult {
    const { store, engine, namespace, machine, transcript, existingSession } = options
    const launchSettings = options.launchSettings ?? {}
    const startedAt = Date.now()
    let stored =
        existingSession === undefined
            ? (importedClaudeSessionsById(store, namespace, machine.id).get(transcript.id) ?? null)
            : existingSession

    // A normal HAPI-created Claude row already contains the history it observed live.
    // Reuse it instead of duplicating the same native conversation into an import row.
    if (stored && !asRecord(stored.metadata)?.claudeImportState) {
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            action: 'unchanged',
            appended: 0
        }
    }

    const created = !stored
    if (!stored) {
        const metadata = buildClaudeMetadata(
            transcript,
            machine,
            {},
            {
                state: 'importing',
                machineId: machine.id,
                claudeSessionId: transcript.id,
                sourceFile: transcript.file,
                startedAt,
                updatedAt: startedAt
            },
            launchSettings
        )
        const initialModel = launchSettings.model !== undefined ? launchSettings.model : transcript.model
        stored = store.sessions.getOrCreateSession(
            `claude-import:${machine.id}:${transcript.id}`,
            metadata,
            {},
            namespace,
            initialModel ?? undefined,
            launchSettings.effort ?? undefined
        )
    } else {
        const existingDelta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript)
        if (existingDelta.error) {
            markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'diverged', existingDelta.error)
            return {
                claudeSessionId: transcript.id,
                hapiSessionId: stored.id,
                error: { code: 'transcript_diverged', message: existingDelta.error }
            }
        }
        if (stored.active) {
            if (existingDelta.messages.length > 0) {
                const message = 'The HAPI Claude session is active; stop it before importing native history changes'
                markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'failed', message)
                return {
                    claudeSessionId: transcript.id,
                    hapiSessionId: stored.id,
                    error: { code: 'session_active', message }
                }
            }
            return {
                claudeSessionId: transcript.id,
                hapiSessionId: stored.id,
                action: 'unchanged',
                appended: 0
            }
        }
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) =>
            buildClaudeMetadata(
                transcript,
                machine,
                metadata,
                {
                    state: 'importing',
                    machineId: machine.id,
                    claudeSessionId: transcript.id,
                    sourceFile: transcript.file,
                    startedAt,
                    updatedAt: startedAt
                },
                launchSettings
            )
        )
    }

    const delta = classifyImportDelta(store.messages.getAllMessages(stored.id), transcript)
    if (delta.error) {
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'diverged', delta.error)
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'transcript_diverged', message: delta.error }
        }
    }
    const appended: StoredMessage[] = []
    try {
        for (const source of delta.messages) {
            const result = store.messages.addImportedMessage(stored.id, source.content, source.localId, source.createdAt)
            if (result.inserted) appended.push(result.message)
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist imported Claude history'
        const state = error instanceof ImportedMessageConflictError ? 'diverged' : 'failed'
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, state, message)
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: {
                code: state === 'diverged' ? 'transcript_diverged' : 'import_failed',
                message
            }
        }
    }

    try {
        updateMetadataWithRetry(store, stored.id, namespace, (metadata) =>
            buildClaudeMetadata(
                transcript,
                machine,
                metadata,
                {
                    state: 'complete',
                    machineId: machine.id,
                    claudeSessionId: transcript.id,
                    sourceFile: transcript.file,
                    startedAt,
                    updatedAt: Date.now()
                },
                launchSettings
            )
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to finalize imported Claude history'
        try {
            markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'failed', message)
        } catch {}
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: { code: 'import_failed', message }
        }
    }

    const resolvedModel = launchSettings.model !== undefined ? launchSettings.model : created ? transcript.model : undefined
    if (resolvedModel !== undefined) {
        store.sessions.setSessionModel(stored.id, resolvedModel ?? null, namespace, { touchUpdatedAt: false })
    }
    if (launchSettings.effort !== undefined) {
        store.sessions.setSessionEffort(stored.id, launchSettings.effort, namespace, { touchUpdatedAt: false })
    }
    const activityAt = appended.at(-1)?.createdAt ?? transcript.modifiedAt
    engine.recordSessionActivity(stored.id, activityAt)
    emitImportedMessages(engine, stored.id, appended)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        claudeSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appended.length > 0 ? 'updated' : 'unchanged',
        appended: appended.length
    }
}

async function importWithLock(key: string, work: () => ClaudeImportResult): Promise<ClaudeImportResult> {
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

export function createClaudeSessionRoutes(options: { store: Store; getSyncEngine: () => SyncEngine | null }): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/claude/sessions', async (c) => {
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, c.req.query('machineId')?.trim() || null)
        if (!engine || !machine)
            return c.json(
                {
                    success: false,
                    error: 'No online machine available for Claude history import',
                    sessions: []
                },
                503
            )
        const result = await engine.listClaudeSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success)
            return c.json(
                {
                    success: false,
                    error: result.error,
                    sessions: [],
                    machineId: machine.id
                },
                503
            )
        const importedByClaudeId = importedClaudeSessionsById(options.store, namespace, machine.id)
        const sessions: ClaudeSessionListItem[] = result.sessions.map((summary) => {
            const imported = importedByClaudeId.get(summary.id)
            const state = asRecord(asRecord(imported?.metadata)?.claudeImportState)?.state
            return {
                ...summary,
                ...(imported ? { hapiSessionId: imported.id } : {}),
                ...(state === 'importing' || state === 'complete' || state === 'failed' || state === 'diverged'
                    ? { importState: state }
                    : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/claude/import-sessions', async (c) => {
        const body = asRecord(await c.req.json().catch(() => null))
        const sessionIds = Array.isArray(body?.sessionIds)
            ? body.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
            : []
        if (sessionIds.length === 0) return c.json({ success: false, error: 'No Claude sessions selected', results: [] }, 400)
        const launchSettings = parseLaunchSettings(body ?? {})
        if (!launchSettings) return c.json({ success: false, error: 'Invalid Claude launch settings', results: [] }, 400)
        const uniqueSessionIds = [...new Set(sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveClaudeMachine(engine, namespace, typeof body?.machineId === 'string' ? body.machineId.trim() : null)
        if (!engine || !machine)
            return c.json(
                {
                    success: false,
                    error: 'No online machine available for Claude history import',
                    results: []
                },
                503
            )
        const remote = await engine.listClaudeSessionsForMachine(
            machine.id,
            typeof body?.cwd === 'string' ? body.cwd.trim() : null,
            uniqueSessionIds
        )
        if (!remote.success)
            return c.json(
                {
                    success: false,
                    error: remote.error,
                    results: [],
                    machineId: machine.id
                },
                503
            )
        const byId = new Map(
            remote.sessions
                .filter((session): session is ClaudeLocalSessionWithMessages => 'messages' in session)
                .map((session) => [session.id, session])
        )
        const importedByClaudeId = importedClaudeSessionsById(options.store, namespace, machine.id)
        const results: ClaudeImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const transcript = byId.get(sessionId)
            if (!transcript) {
                results.push({
                    claudeSessionId: sessionId,
                    error: {
                        code: 'not_found',
                        message: 'Claude session transcript not found'
                    }
                })
                continue
            }
            results.push(
                await importWithLock(`${namespace}:${machine.id}:${sessionId}`, () =>
                    importClaudeSession({
                        store: options.store,
                        engine,
                        namespace,
                        machine,
                        transcript,
                        existingSession: importedByClaudeId.get(sessionId) ?? null,
                        launchSettings
                    })
                )
            )
        }
        return c.json({
            success: results.every((result) => !result.error),
            results,
            machineId: machine.id
        })
    })

    return app
}

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { Hono } from 'hono'
import { CLAUDE_IMPORT_PAGE_BYTES } from '@hapi/protocol/apiTypes'
import {
    normalizeClaudeAgentEventForImport,
    normalizeClaudeImportedUserText
} from '@hapi/protocol/messages'
import type {
    ClaudeImportedMessage,
    ClaudeLocalSessionSummary,
    ClaudeLocalSessionWithMessages,
    ListClaudeSessionsRpcResponse
} from '@hapi/protocol/apiTypes'
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
    transcript: ClaudeLocalSessionSummary,
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

function applyClaudeLaunchSettings(
    store: Store,
    sessionId: string,
    namespace: string,
    launchSettings: ClaudeImportLaunchSettings
): void {
    if (launchSettings.permissionMode !== undefined) {
        updateMetadataWithRetry(
            store,
            sessionId,
            namespace,
            (metadata) => ({ ...metadata, preferredPermissionMode: launchSettings.permissionMode }) as Metadata
        )
    }
    if (launchSettings.model !== undefined) {
        store.sessions.setSessionModel(sessionId, launchSettings.model, namespace, { touchUpdatedAt: false })
    }
    if (launchSettings.effort !== undefined) {
        store.sessions.setSessionEffort(sessionId, launchSettings.effort, namespace, { touchUpdatedAt: false })
    }
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

function storedClaudeLocalId(message: StoredMessage, sessionId: string): string | null {
    if (message.localId?.startsWith(importedPrefix(sessionId))) return message.localId
    const envelope = asRecord(message.content)
    const meta = asRecord(envelope?.meta)
    const localId = meta?.claudeTranscriptLocalId
    return typeof localId === 'string' && localId.startsWith(importedPrefix(sessionId)) ? localId : null
}

type ClaudeImportBoundaryEntry =
    | { type: 'user'; text: string }
    | { type: 'agent'; contentDigest: string }

type ClaudeImportBoundary = {
    exact: { localId: string; contentDigest: string } | null
    trailingEntries: ClaudeImportBoundaryEntry[]
}

type ClaudeImportCursor = {
    messageCount: number
    lastLocalId: string | null
    prefixDigest: string
}

type ClaudeTranscriptAnalysis = ClaudeImportCursor & {
    summary: ClaudeLocalSessionSummary
    observedCount: number
    error?: string
}

type ClaudePageLoader = (cursor: number) => Promise<ListClaudeSessionsRpcResponse>

class ClaudeImportStreamError extends Error {
    constructor(
        readonly code: 'not_found' | 'transcript_changed' | 'import_failed',
        message: string
    ) {
        super(message)
        this.name = 'ClaudeImportStreamError'
    }
}

function canonicalContent(value: unknown): unknown {
    const content = truncateOversizedMessageContent(value)
    const sourceEnvelope = asRecord(content)
    if (!sourceEnvelope) return content
    const meta = asRecord(sourceEnvelope.meta)
    let envelope = sourceEnvelope
    if (typeof meta?.claudeTranscriptLocalId === 'string') {
        const canonicalMeta = { ...meta }
        delete canonicalMeta.claudeTranscriptLocalId
        envelope = { ...sourceEnvelope, meta: canonicalMeta }
    }
    const body = asRecord(envelope?.content)
    if (envelope.role !== 'user' || body?.type !== 'text' || typeof body.text !== 'string') return envelope
    const text = normalizeClaudeImportedUserText(body.text)
    return text === body.text ? envelope : { ...envelope, content: { ...body, text } }
}

function contentDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(canonicalContent(value))).digest('hex')
}

function stableClaudeAgentDigest(value: unknown, sessionId: string): string | null {
    const envelope = asRecord(value)
    const output = asRecord(envelope?.content)
    const event = asRecord(output?.data)
    if (
        envelope?.role !== 'agent' ||
        output?.type !== 'output' ||
        typeof event?.type !== 'string' ||
        event.sessionId !== sessionId
    ) {
        return null
    }
    const stableEvent = normalizeClaudeAgentEventForImport(event)
    return contentDigest({ ...envelope, content: { ...output, data: stableEvent } })
}

function nextTranscriptDigest(previous: string, message: ClaudeImportedMessage): string {
    return createHash('sha256')
        .update(previous)
        .update('\0')
        .update(message.localId)
        .update('\0')
        .update(JSON.stringify(canonicalContent(message.content)))
        .digest('hex')
}

function storedImportCursor(session: StoredSession): ClaudeImportCursor | null {
    const state = asRecord(storedMetadata(session).claudeImportState)
    return typeof state?.messageCount === 'number' &&
        Number.isInteger(state.messageCount) &&
        state.messageCount >= 0 &&
        (typeof state.lastLocalId === 'string' || state.lastLocalId === null) &&
        typeof state.prefixDigest === 'string'
        ? {
            messageCount: state.messageCount,
            lastLocalId: state.lastLocalId,
            prefixDigest: state.prefixDigest
        }
        : null
}

function findClaudeImportBoundary(store: Store, session: StoredSession, claudeSessionId: string): ClaudeImportBoundary {
    let beforeSeq = Number.MAX_SAFE_INTEGER
    const trailingEntries: ClaudeImportBoundaryEntry[] = []
    while (true) {
        const page = store.messages.getMessagesBeforeSeq(session.id, beforeSeq)
        if (page.length === 0) return { exact: null, trailingEntries: trailingEntries.reverse() }
        for (const message of page) {
            const localId = storedClaudeLocalId(message, claudeSessionId)
            if (localId) {
                return {
                    exact: { localId, contentDigest: contentDigest(message.content) },
                    trailingEntries: trailingEntries.reverse()
                }
            }
            const envelope = asRecord(message.content)
            const body = asRecord(envelope?.content)
            if (envelope?.role === 'user' && body?.type === 'text' && typeof body.text === 'string') {
                trailingEntries.push({ type: 'user', text: body.text })
                continue
            }
            const agentDigest = stableClaudeAgentDigest(message.content, claudeSessionId)
            if (agentDigest) trailingEntries.push({ type: 'agent', contentDigest: agentDigest })
        }
        beforeSeq = page.at(-1)!.seq
    }
}

async function visitClaudeTranscriptPages(options: {
    loadPage: ClaudePageLoader
    sessionId: string
    startCursor?: number
    expectedSummary?: ClaudeLocalSessionSummary
    onMessage: (message: ClaudeImportedMessage, index: number) => void | Promise<void>
}): Promise<ClaudeLocalSessionSummary> {
    let cursor = options.startCursor ?? 0
    let summary = options.expectedSummary ?? null
    while (true) {
        const remote = await options.loadPage(cursor)
        if (!remote.success) {
            throw new ClaudeImportStreamError(
                remote.error.toLowerCase().includes('not found') ? 'not_found' : 'import_failed',
                remote.error
            )
        }
        if (remote.mode !== 'messages' || remote.page.session.id !== options.sessionId) {
            throw new ClaudeImportStreamError('import_failed', 'Invalid Claude transcript page response')
        }
        const page = remote.page
        if (summary && !isSameTranscriptSnapshot(summary, page.session)) {
            throw new ClaudeImportStreamError(
                'transcript_changed',
                'Claude transcript changed while it was being imported; retry the import'
            )
        }
        summary ??= page.session
        for (let offset = 0; offset < page.messages.length; offset += 1) {
            await options.onMessage(page.messages[offset]!, cursor + offset)
        }
        const expectedCursor = cursor + page.messages.length
        if (page.nextCursor === null) {
            if (expectedCursor !== page.session.messageCount) {
                throw new ClaudeImportStreamError('import_failed', 'Incomplete Claude transcript page sequence')
            }
            if (!summary) throw new ClaudeImportStreamError('not_found', 'Claude session transcript not found')
            return summary
        }
        if (
            page.nextCursor !== expectedCursor ||
            page.nextCursor <= cursor ||
            page.nextCursor > page.session.messageCount
        ) {
            throw new ClaudeImportStreamError('import_failed', 'Invalid Claude transcript page cursor')
        }
        cursor = page.nextCursor
    }
}

async function analyzeClaudeTranscript(options: {
    loadPage: ClaudePageLoader
    sessionId: string
    boundary: ClaudeImportBoundary
    priorCursor: ClaudeImportCursor | null
}): Promise<ClaudeTranscriptAnalysis> {
    let digest = ''
    let lastLocalId: string | null = null
    let priorCursorVerified = options.priorCursor === null || options.priorCursor.messageCount === 0
    let exactBoundaryIndex: number | null = null
    let exactBoundaryChanged = false
    let trailingEntryIndex: number | null = null
    let matchedTrailingEntries = 0

    const summary = await visitClaudeTranscriptPages({
        loadPage: options.loadPage,
        sessionId: options.sessionId,
        onMessage: (message, index) => {
            digest = nextTranscriptDigest(digest, message)
            lastLocalId = message.localId
            if (options.priorCursor && index + 1 === options.priorCursor.messageCount) {
                priorCursorVerified = digest === options.priorCursor.prefixDigest &&
                    message.localId === options.priorCursor.lastLocalId
            }
            if (options.boundary.exact?.localId === message.localId) {
                exactBoundaryIndex = index
                exactBoundaryChanged = contentDigest(message.content) !== options.boundary.exact.contentDigest
                return
            }
            if (options.boundary.exact && exactBoundaryIndex === null) return
            const trailingTarget = trailingEntryIndex === null
                ? (exactBoundaryIndex === null ? 0 : exactBoundaryIndex + 1)
                : trailingEntryIndex + 1
            if (index !== trailingTarget) return

            const nextEntry = options.boundary.trailingEntries[matchedTrailingEntries]
            if (message.content.role === 'agent') {
                if (
                    nextEntry?.type === 'agent' &&
                    stableClaudeAgentDigest(message.content, options.sessionId) === nextEntry.contentDigest
                ) {
                    matchedTrailingEntries += 1
                    trailingEntryIndex = index
                }
                return
            }
            if (nextEntry?.type !== 'user') return

            let batch = ''
            for (let end = matchedTrailingEntries; end < options.boundary.trailingEntries.length; end += 1) {
                const entry = options.boundary.trailingEntries[end]!
                if (entry.type !== 'user') break
                batch = batch.length === 0 ? entry.text : `${batch}\n${entry.text}`
                if (message.content.content.text === normalizeClaudeImportedUserText(batch)) {
                    matchedTrailingEntries = end + 1
                    trailingEntryIndex = index
                    break
                }
            }
        }
    })

    const priorCount = options.priorCursor?.messageCount ?? 0
    const exactCount = exactBoundaryIndex === null ? 0 : exactBoundaryIndex + 1
    const trailingCount = trailingEntryIndex === null ? 0 : trailingEntryIndex + 1
    let error: string | undefined
    if (priorCount > summary.messageCount || !priorCursorVerified) {
        error = 'Local Claude transcript no longer extends the previously imported history'
    } else if (options.boundary.exact && exactBoundaryIndex === null) {
        error = 'Local Claude transcript no longer contains the latest observed history entry'
    } else if (exactBoundaryChanged && options.boundary.exact) {
        error = `Local Claude transcript changed imported entry ${options.boundary.exact.localId}`
    }
    return {
        summary,
        messageCount: summary.messageCount,
        lastLocalId,
        prefixDigest: digest,
        observedCount: Math.max(priorCount, exactCount, trailingCount),
        ...(error ? { error } : {})
    }
}

function markImportState(
    store: Store,
    engine: SyncEngine,
    sessionId: string,
    namespace: string,
    transcript: ClaudeLocalSessionSummary,
    machineId: string,
    state: 'failed' | 'diverged',
    error: string
): void {
    const current = store.sessions.getSessionByNamespace(sessionId, namespace)
    const currentState = asRecord(asRecord(current?.metadata)?.claudeImportState)
    const currentCursor = current ? storedImportCursor(current) : null
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
                    ...(currentCursor ?? {}),
                    error
                }
            }) as Metadata
    )
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId })
}

async function importClaudeSessionFromPages(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    claudeSessionId: string
    loadPage: ClaudePageLoader
    existingSession?: StoredSession | null
    launchSettings?: ClaudeImportLaunchSettings
}): Promise<ClaudeImportResult> {
    const { store, engine, namespace, machine, claudeSessionId, existingSession } = options
    const launchSettings = options.launchSettings ?? {}
    const startedAt = Date.now()
    let stored =
        existingSession === undefined
            ? (importedClaudeSessionsById(store, namespace, machine.id).get(claudeSessionId) ?? null)
            : existingSession
    const boundary = stored
        ? findClaudeImportBoundary(store, stored, claudeSessionId)
        : { exact: null, trailingEntries: [] }
    let analysis: ClaudeTranscriptAnalysis
    try {
        analysis = await analyzeClaudeTranscript({
            loadPage: options.loadPage,
            sessionId: claudeSessionId,
            boundary,
            priorCursor: stored ? storedImportCursor(stored) : null
        })
    } catch (error) {
        const streamError = error instanceof ClaudeImportStreamError ? error : null
        return {
            claudeSessionId,
            error: {
                code: streamError?.code ?? 'import_failed',
                message: error instanceof Error ? error.message : 'Failed to read Claude transcript'
            }
        }
    }
    const transcript = analysis.summary

    if (analysis.error && stored) {
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'diverged', analysis.error)
        return {
            claudeSessionId,
            hapiSessionId: stored.id,
            error: { code: 'transcript_diverged', message: analysis.error }
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
        if (stored.active) {
            if (analysis.observedCount < analysis.messageCount) {
                const message = 'The HAPI Claude session is active; stop it before importing native history changes'
                markImportState(store, engine, stored.id, namespace, transcript, machine.id, 'failed', message)
                return {
                    claudeSessionId: transcript.id,
                    hapiSessionId: stored.id,
                    error: { code: 'session_active', message }
                }
            }
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
                        updatedAt: Date.now(),
                        messageCount: analysis.messageCount,
                        lastLocalId: analysis.lastLocalId,
                        prefixDigest: analysis.prefixDigest
                    },
                    launchSettings
                )
            )
            applyClaudeLaunchSettings(store, stored.id, namespace, launchSettings)
            engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
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

    let appended = 0
    let lastActivityAt: number | null = null
    try {
        if (analysis.observedCount < analysis.messageCount) {
            await visitClaudeTranscriptPages({
                loadPage: options.loadPage,
                sessionId: claudeSessionId,
                startCursor: analysis.observedCount,
                expectedSummary: transcript,
                onMessage: (source) => {
                    const result = store.messages.addImportedMessage(
                        stored!.id,
                        source.content,
                        source.localId,
                        source.createdAt
                    )
                    if (!result.inserted) return
                    appended += 1
                    lastActivityAt = result.message.createdAt
                    emitImportedMessages(engine, stored!.id, [result.message])
                }
            })
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to persist imported Claude history'
        const state = error instanceof ImportedMessageConflictError ? 'diverged' : 'failed'
        const streamError = error instanceof ClaudeImportStreamError ? error : null
        markImportState(store, engine, stored.id, namespace, transcript, machine.id, state, message)
        return {
            claudeSessionId: transcript.id,
            hapiSessionId: stored.id,
            error: {
                code: state === 'diverged' ? 'transcript_diverged' : (streamError?.code ?? 'import_failed'),
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
                    updatedAt: Date.now(),
                    messageCount: analysis.messageCount,
                    lastLocalId: analysis.lastLocalId,
                    prefixDigest: analysis.prefixDigest
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
    const activityAt = lastActivityAt ?? transcript.modifiedAt
    engine.recordSessionActivity(stored.id, activityAt)
    engine.handleRealtimeEvent({ type: 'session-updated', sessionId: stored.id })
    return {
        claudeSessionId: transcript.id,
        hapiSessionId: stored.id,
        action: created ? 'created' : appended > 0 ? 'updated' : 'unchanged',
        appended
    }
}

export async function importClaudeSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: ClaudeLocalSessionWithMessages
    existingSession?: StoredSession | null
    launchSettings?: ClaudeImportLaunchSettings
}): Promise<ClaudeImportResult> {
    return await importClaudeSessionFromPages({
        store: options.store,
        engine: options.engine,
        namespace: options.namespace,
        machine: options.machine,
        claudeSessionId: options.transcript.id,
        existingSession: options.existingSession,
        launchSettings: options.launchSettings,
        loadPage: async (cursor) => {
            const messages = options.transcript.messages.slice(cursor, cursor + 1)
            const nextCursor = cursor + messages.length
            return {
                success: true,
                mode: 'messages',
                page: {
                    session: {
                        id: options.transcript.id,
                        title: options.transcript.title,
                        lastUserMessage: options.transcript.lastUserMessage,
                        cwd: options.transcript.cwd,
                        file: options.transcript.file,
                        modifiedAt: options.transcript.modifiedAt,
                        model: options.transcript.model,
                        messageCount: options.transcript.messageCount
                    },
                    messages,
                    nextCursor: nextCursor < options.transcript.messageCount ? nextCursor : null
                }
            }
        }
    })
}

async function importWithLock(key: string, work: () => ClaudeImportResult | Promise<ClaudeImportResult>): Promise<ClaudeImportResult> {
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

function isSameTranscriptSnapshot(first: ClaudeLocalSessionSummary, next: ClaudeLocalSessionSummary): boolean {
    return first.id === next.id
        && first.file === next.file
        && first.modifiedAt === next.modifiedAt
        && first.messageCount === next.messageCount
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
        const result = await engine.listClaudeSessionSummariesForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success || result.mode !== 'summaries')
            return c.json(
                {
                    success: false,
                    error: result.success ? 'Invalid Claude session list response' : result.error,
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
        const importedByClaudeId = importedClaudeSessionsById(options.store, namespace, machine.id)
        const results: ClaudeImportResult[] = []
        const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : null
        for (const sessionId of uniqueSessionIds) {
            results.push(
                await importWithLock(`${namespace}:${machine.id}:${sessionId}`, async () => {
                    return await importClaudeSessionFromPages({
                        store: options.store,
                        engine,
                        namespace,
                        machine,
                        claudeSessionId: sessionId,
                        loadPage: async (cursor) => await engine.listClaudeSessionPageForMachine(machine.id, {
                            cwd,
                            sessionId,
                            cursor,
                            maxBytes: CLAUDE_IMPORT_PAGE_BYTES
                        }),
                        existingSession: importedByClaudeId.get(sessionId) ?? null,
                        launchSettings
                    })
                })
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

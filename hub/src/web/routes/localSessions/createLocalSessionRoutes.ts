import { Hono } from 'hono'
import type { PermissionMode } from '@hapi/protocol/types'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol/modes'
import { MAX_LOCAL_SESSION_IMPORTS, type LocalTranscript } from '@hapi/protocol/localTranscript'
import type { CodexCollaborationMode } from '@hapi/protocol/types'
import type { Machine, SyncEngine } from '../../../sync/syncEngine'
import type { Store, StoredSession } from '../../../store'
import type { WebAppEnv } from '../../middleware/auth'
import { fetchLocalTranscriptSummaries, fetchLocalTranscriptsByIds } from './fetchLocalTranscripts'
import { pickImportMachine } from './machinePick'
import { findImportedLocalSession, importLocalTranscript, type LocalImportLaunchConfig, type LocalImportOutcome } from './importLocalTranscript'
import type { HubLocalSessionSource } from './sources'

/**
 * Generic local-session import routes. One list + one import
 * route pair per registered source; response items stay in the legacy shape
 * (flavor `extra` fields flattened, legacy result id key preserved).
 */

const IMPORT_STATES = ['importing', 'complete', 'failed', 'diverged'] as const

export type LocalSessionImportDelegateContext = {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    sessionIds: string[]
    cwd: string | null
    body: Record<string, unknown>
}

/** Temporary (commit 2): delegates imports to the legacy per-flavor path. */
export type LocalSessionImportDelegate = (ctx: LocalSessionImportDelegateContext) => Promise<Response> | Response

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function importedSessionsByNativeId(options: {
    store: Store
    namespace: string
    source: HubLocalSessionSource
    machineId: string
}): Map<string, StoredSession> {
    const { store, namespace, source, machineId } = options
    const primaryKey = source.nativeIdKeys[0]
    const imported = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = asRecord(session.metadata)
        if (metadata?.flavor !== source.flavor || metadata.machineId !== machineId) continue
        const nativeId = metadata[primaryKey]
        if (typeof nativeId !== 'string' || imported.has(nativeId)) continue
        imported.set(nativeId, session)
    }
    return imported
}

function toListItem(options: {
    source: HubLocalSessionSource
    summary: Record<string, unknown>
    imported: StoredSession | null
}): Record<string, unknown> {
    const { source, summary, imported } = options
    const item: Record<string, unknown> = { ...summary }
    delete item.flavor
    delete item.launch
    const extra = asRecord(summary.extra)
    if (extra) {
        delete item.extra
        Object.assign(item, extra)
    }
    if (source.match.strategy === 'anchored' && imported) {
        item.hapiSessionId = imported.id
    }
    if (source.importStateKey && imported) {
        const state = asRecord(asRecord(imported.metadata)?.[source.importStateKey])?.state
        if (typeof state === 'string' && (IMPORT_STATES as readonly string[]).includes(state)) {
            item.importState = state
        }
    }
    return item
}

function extractLaunchConfig(body: Record<string, unknown>): {
    launch: LocalImportLaunchConfig
    validationError?: string
} {
    const launch: LocalImportLaunchConfig = {}
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key)
    // Property presence matters: applySessionConfig only resets a persisted
    // value when the key is present, so explicit nulls / 'default' must be
    // preserved to clear stale selections on re-import.
    if (has('model')) launch.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null
    if (has('modelReasoningEffort')) {
        launch.modelReasoningEffort = typeof body.modelReasoningEffort === 'string' && body.modelReasoningEffort.trim()
            ? body.modelReasoningEffort.trim()
            : null
    }
    if (has('permissionMode')) {
        launch.permissionMode = typeof body.permissionMode === 'string' && body.permissionMode.trim()
            ? body.permissionMode.trim() as PermissionMode
            : null
    }
    if (has('serviceTier')) {
        launch.serviceTier = body.serviceTier === null || body.serviceTier === undefined
            ? null
            : typeof body.serviceTier === 'string' ? body.serviceTier : undefined
        if (launch.serviceTier !== null && launch.serviceTier !== 'fast' && launch.serviceTier !== 'standard') {
            return { launch, validationError: 'Invalid serviceTier' }
        }
    }
    if (has('collaborationMode')) {
        launch.collaborationMode = typeof body.collaborationMode === 'string'
            ? body.collaborationMode as CodexCollaborationMode
            : null
        if (launch.collaborationMode !== 'default' && launch.collaborationMode !== 'plan') {
            return { launch, validationError: 'Invalid collaborationMode' }
        }
    }
    return { launch }
}

export function createLocalSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
    sources: HubLocalSessionSource[]
    importDelegates?: Partial<Record<string, LocalSessionImportDelegate>>
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    for (const source of options.sources) {
        const listPath = `/${source.routeBase}/sessions`
        const importPath = `/${source.routeBase}/import-sessions`

        app.get(listPath, async (c) => {
            const namespace = c.get('namespace')
            if (source.namespaceGate && namespace !== source.namespaceGate.namespace) {
                return c.json({ success: false, error: source.namespaceGate.error, sessions: [] }, 403)
            }
            const machine = pickImportMachine({
                engine: options.getSyncEngine(),
                namespace,
                requestedMachineId: c.req.query('machineId')?.trim() || null,
                cwd: c.req.query('cwd')?.trim() || null,
                mode: source.machinePick
            })
            if (!machine) {
                return c.json({ success: false, error: `No online machine available for ${source.displayName} history import`, sessions: [] }, 503)
            }
            const result = await fetchLocalTranscriptSummaries({
                source,
                engine: options.getSyncEngine()!,
                machine,
                cwd: c.req.query('cwd')?.trim() || null
            })
            if (!result.success) {
                return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
            }
            const annotate = source.match.strategy === 'anchored'
            const importedByNativeId = annotate
                ? importedSessionsByNativeId({ store: options.store, namespace, source, machineId: machine.id })
                : new Map<string, StoredSession>()
            const sessions = result.sessions.map((summary) => toListItem({
                source,
                summary: summary as unknown as Record<string, unknown>,
                imported: importedByNativeId.get(summary.id) ?? null
            }))
            return c.json({ success: true, sessions, machineId: machine.id })
        })

        app.post(importPath, async (c) => {
            const namespace = c.get('namespace')
            if (source.namespaceGate && namespace !== source.namespaceGate.namespace) {
                return c.json({ success: false, error: source.namespaceGate.error }, 403)
            }
            const body = asRecord(await c.req.json().catch(() => null)) ?? {}
            const rawSessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : []
            if (rawSessionIds.length > MAX_LOCAL_SESSION_IMPORTS) {
                return c.json({ success: false, error: `At most ${MAX_LOCAL_SESSION_IMPORTS} ${source.displayName} sessions can be imported at once`, results: [] }, 400)
            }
            const sessionIds = rawSessionIds
                .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
                .map((id) => id.trim())
            if (sessionIds.length === 0) {
                return c.json({ success: false, error: `No ${source.displayName} sessions selected`, results: [] }, 400)
            }
            const uniqueSessionIds = [...new Set(sessionIds)]
            const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null
            const engine = options.getSyncEngine()
            const machine = pickImportMachine({
                engine,
                namespace,
                requestedMachineId: typeof body.machineId === 'string' ? body.machineId.trim() : null,
                cwd,
                mode: source.machinePick
            })
            if (!engine || !machine) {
                return c.json({ success: false, error: `No online machine available for ${source.displayName} history import`, results: [] }, 503)
            }

            const delegate = options.importDelegates?.[source.flavor]
            if (delegate) {
                return await delegate({ store: options.store, engine, namespace, machine, sessionIds: uniqueSessionIds, cwd, body })
            }

            const { launch, validationError } = extractLaunchConfig(body)
            if (validationError) {
                return c.json({ success: false, error: validationError, results: [] }, 400)
            }
            if (launch.permissionMode !== undefined
                && launch.permissionMode !== null
                && !isPermissionModeAllowedForFlavor(launch.permissionMode, source.flavor)) {
                return c.json({ success: false, error: `Invalid permission mode for ${source.displayName} sessions`, results: [] }, 400)
            }

            const fetched = await fetchLocalTranscriptsByIds({
                source,
                engine,
                machine,
                cwd,
                sessionIds: uniqueSessionIds
            })
            if (!fetched.success) {
                return c.json({ success: false, error: fetched.error, results: [], machineId: machine.id }, 503)
            }
            const transcripts = new Map(fetched.sessions
                .filter((session): session is LocalTranscript => 'messages' in session)
                .map((session) => [session.id, session]))
            const resultIdKey = source.legacy?.resultIdKey ?? `${source.flavor}SessionId`
            const requestMetadata = source.requestMetadata?.(body)
            const results: Array<LocalImportOutcome & Record<string, unknown>> = []
            for (const sessionId of uniqueSessionIds) {
                const transcript = transcripts.get(sessionId)
                if (!transcript) {
                    results.push({
                        sessionId,
                        [resultIdKey]: sessionId,
                        error: { code: 'not_found', message: `${source.displayName} session transcript not found` }
                    })
                    if (source.batch === 'stopOnFirstError') break
                    continue
                }
                const outcome = await importLocalTranscript({
                    store: options.store,
                    engine,
                    namespace,
                    source,
                    transcript,
                    machine,
                    request: { launch, requestMetadata }
                })
                results.push({ ...outcome, [resultIdKey]: outcome.sessionId })
                if (source.batch === 'stopOnFirstError' && outcome.error) break
            }
            return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
        })
    }

    return app
}
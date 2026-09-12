/**
 * Cursor flavor of the multi-agent session import surface.
 *
 * Mirrors the codex import route shape (`hub/src/web/routes/codexDesktop.ts`,
 * shipped upstream in `tiann/hapi#796`) so the diff parallel between the
 * two routes minimizes review friction. The cursor endpoints live
 * alongside the codex endpoints rather than under a generalized
 * `/api/agent-sessions/...` umbrella; only the shared types live in
 * `_agentImport/types.ts`.
 *
 * Endpoints:
 *   GET  /api/cursor/importable-sessions  → list cursor chats via machine RPC
 *   POST /api/cursor/import { selections[] } | { uuids[], workspacePath? } → import N rows
 *
 * Prefer `selections` (uuid + discovered workspacePath per row) so legacy
 * drawers stay resumable. `uuids` + optional global `workspacePath` remains
 * for older clients / tests.
 *
 * Discovery + on-disk prepare run on the selected online machine via RPC.
 * Hub stamps already-imported flags and creates HAPI session rows after prepare.
 */

import { Hono } from 'hono'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import {
    buildAlreadyImportedIndex,
    buildImportedSessionMetadata,
    collectCandidateWorkspacePaths,
    stampAlreadyImportedOnSessions
} from '../../cursor/cursorImporter'
import {
    fanOutImportAcrossOnlineMachines,
    mergeImportSessionsById,
    resolveRequestedImportMachineId
} from './transcriptImport'
import type {
    CursorImportRefusalReason,
    CursorImportResponse,
    CursorImportRowOutcome,
    CursorImportableSessionSummary,
    CursorImportableSessionsResponse
} from './_agentImport/types'

const CURSOR_IMPORT_NAMESPACE_ERROR = 'Cursor session import is not available outside the default namespace'
const NO_CURSOR_SESSION_SELECTED_ERROR = 'No cursor sessions selected for import'
const NO_ONLINE_MACHINE_ERROR = 'No online machine available for Cursor history import'

function getLogRoot(): string {
    const configured = process.env.HAPI_CURSOR_LOG_ROOT?.trim()
    return configured || process.cwd()
}

function appendImportLog(message: string): void {
    try {
        const logDir = join(getLogRoot(), 'logs')
        mkdirSync(logDir, { recursive: true })
        const line = `[${new Date().toISOString()}] [cursor-import] ${message}\n`
        appendFileSync(join(logDir, 'CursorImport.log'), line, 'utf-8')
    } catch {
        // best-effort
    }
}

interface CursorImportRequestParseResult {
    selections: Array<{ uuid: string; workspacePath: string | null; machineId: string | null }>
    machineId?: string | null
    error?: string
}

function parseWorkspacePath(value: unknown): { ok: true; value: string | null } | { ok: false } {
    if (value === undefined || value === null) {
        return { ok: true, value: null }
    }
    if (typeof value !== 'string') {
        return { ok: false }
    }
    const trimmed = value.trim()
    return { ok: true, value: trimmed.length > 0 ? trimmed : null }
}

function parseImportRequest(body: unknown): CursorImportRequestParseResult {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { selections: [] }
    }
    const record = body as Record<string, unknown>

    const globalPath = parseWorkspacePath(record.workspacePath)
    if (!globalPath.ok) {
        return { selections: [], error: 'Invalid workspacePath' }
    }

    const machineId = typeof record.machineId === 'string' && record.machineId.trim()
        ? record.machineId.trim()
        : null

    if (Array.isArray(record.selections)) {
        const selections: Array<{ uuid: string; workspacePath: string | null; machineId: string | null }> = []
        const seen = new Set<string>()
        for (const entry of record.selections) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                return { selections: [], error: 'Invalid selections' }
            }
            const row = entry as Record<string, unknown>
            if (typeof row.uuid !== 'string') {
                return { selections: [], error: 'Invalid selections' }
            }
            const uuid = row.uuid.trim()
            if (!uuid || seen.has(uuid)) {
                continue
            }
            const rowPath = parseWorkspacePath(row.workspacePath)
            if (!rowPath.ok) {
                return { selections: [], error: 'Invalid workspacePath' }
            }
            const rowMachineId = typeof row.machineId === 'string' && row.machineId.trim()
                ? row.machineId.trim()
                : machineId
            seen.add(uuid)
            selections.push({
                uuid,
                workspacePath: rowPath.value ?? globalPath.value,
                machineId: rowMachineId
            })
        }
        return { selections, machineId }
    }

    const rawUuids = record.uuids
    let uuids: string[] = []
    if (Array.isArray(rawUuids)) {
        for (const value of rawUuids) {
            if (typeof value !== 'string') {
                return { selections: [], error: 'Invalid uuids' }
            }
            const trimmed = value.trim()
            if (trimmed) uuids.push(trimmed)
        }
    } else if (rawUuids !== undefined) {
        return { selections: [], error: 'Invalid uuids' }
    }
    uuids = Array.from(new Set(uuids))

    return {
        selections: uuids.map((uuid) => ({
            uuid,
            workspacePath: globalPath.value,
            machineId
        })),
        machineId
    }
}

async function listCursorImportableSessionsViaMachine(options: {
    engine: SyncEngine | null
    store: Store
    namespace: string
    machineId?: string | null
}): Promise<{ sessions: CursorImportableSessionSummary[]; error?: string }> {
    const candidateWorkspacePaths = collectCandidateWorkspacePaths(options.store, options.namespace)
    const fanOut = await fanOutImportAcrossOnlineMachines({
        engine: options.engine,
        namespace: options.namespace,
        requestedMachineId: options.machineId,
        noOnlineError: NO_ONLINE_MACHINE_ERROR,
        run: async (machineId) => {
            const result = await options.engine!.listCursorImportableSessionsForMachine(
                machineId,
                candidateWorkspacePaths
            )
            if (!result || typeof result !== 'object') {
                throw new Error('Unexpected Cursor importable sessions RPC response')
            }
            if (result.success !== true) {
                throw new Error(result.error || 'Failed to list Cursor importable sessions')
            }
            return result.sessions.map((session) => ({
                ...session,
                machineId,
                alreadyImportedHapiSessionId: null as string | null
            }))
        }
    })
    if (fanOut.error) {
        return { sessions: [], error: fanOut.error }
    }
    const stamped = fanOut.results.flatMap(({ value }) => value)
    return {
        sessions: stampAlreadyImportedOnSessions(
            mergeImportSessionsById(stamped),
            options.store,
            options.namespace
        )
    }
}

function resolveMachineHomeDir(engine: SyncEngine | null, machineId: string): string {
    const machine = engine?.getMachine(machineId)
    const recorded = machine?.metadata?.homeDir
    return typeof recorded === 'string' && recorded.trim().length > 0 ? recorded.trim() : ''
}

async function importCursorSelectionViaMachine(options: {
    engine: SyncEngine | null
    store: Store
    namespace: string
    machineId: string
    selection: { uuid: string; workspacePath: string | null }
    getSyncEngine: () => SyncEngine | null
}): Promise<CursorImportRowOutcome> {
    const start = Date.now()
    const failure = (reason: CursorImportRefusalReason, message: string): CursorImportRowOutcome => ({
        ok: false,
        uuid: options.selection.uuid,
        reason,
        message,
        durationMs: Date.now() - start
    })

    const alreadyImported = buildAlreadyImportedIndex(options.store, options.namespace).get(options.selection.uuid)
    if (alreadyImported) {
        return failure('already_imported', `cursor session ${options.selection.uuid} is already imported as Hapi session ${alreadyImported}`)
    }

    if (!options.engine) {
        return failure('internal_error', NO_ONLINE_MACHINE_ERROR)
    }

    const prepared = await options.engine.prepareCursorImportForMachine(
        options.machineId,
        options.selection.uuid,
        options.selection.workspacePath
    )
    if (!prepared || typeof prepared !== 'object') {
        return failure('internal_error', 'Unexpected Cursor import prepare RPC response')
    }
    if (prepared.success !== true) {
        return {
            ok: false,
            uuid: prepared.uuid,
            reason: prepared.reason as CursorImportRefusalReason,
            message: prepared.message,
            durationMs: prepared.durationMs
        }
    }

    // Re-check after prepare: verify/transplant can take tens of seconds; overlapping
    // imports may both pass the preflight index and race into getOrCreateSession.
    const alreadyAfterPrepare = buildAlreadyImportedIndex(options.store, options.namespace).get(options.selection.uuid)
    if (alreadyAfterPrepare) {
        return failure(
            'already_imported',
            `cursor session ${options.selection.uuid} is already imported as Hapi session ${alreadyAfterPrepare}`
        )
    }

    const homeDir = resolveMachineHomeDir(options.engine, options.machineId)
    const metadata = buildImportedSessionMetadata({
        uuid: prepared.uuid,
        workspacePath: prepared.workspacePath,
        title: prepared.title,
        hostName: prepared.hostName,
        homeDir,
        machineId: options.machineId
    })

    try {
        const engine = options.getSyncEngine()
        const created = engine?.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
            ?? options.store.sessions.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
        return {
            ok: true,
            uuid: prepared.uuid,
            hapiSessionId: created.id,
            sourceFormat: prepared.sourceFormat,
            durationMs: Date.now() - start
        }
    } catch (err) {
        return failure('internal_error', `failed to create Hapi session row: ${err instanceof Error ? err.message : String(err)}`)
    }
}

export function createCursorImportRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/cursor/*', async (c, next) => {
        if (c.get('namespace') !== 'default') {
            return c.json({
                success: false,
                error: CURSOR_IMPORT_NAMESPACE_ERROR
            }, 403)
        }
        return next()
    })

    app.get('/cursor/importable-sessions', async (c) => {
        const engine = options.getSyncEngine()
        const machineId = c.req.query('machineId')?.trim() || null
        const remote = await listCursorImportableSessionsViaMachine({
            engine,
            store: options.store,
            namespace: c.get('namespace'),
            machineId
        })
        if (remote.error) {
            return c.json({
                success: false,
                error: remote.error,
                sessions: []
            }, 503)
        }
        return c.json({
            success: true,
            sessions: remote.sessions
        } satisfies CursorImportableSessionsResponse)
    })

    app.post('/cursor/import', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseImportRequest(body)
        if (parsed.error) {
            appendImportLog(`FAILED: ${parsed.error}`)
            return c.json({
                success: false,
                error: parsed.error
            }, 400)
        }
        if (parsed.selections.length === 0) {
            appendImportLog(`FAILED: ${NO_CURSOR_SESSION_SELECTED_ERROR}`)
            return c.json({
                success: false,
                error: NO_CURSOR_SESSION_SELECTED_ERROR
            }, 400)
        }

        const engine = options.getSyncEngine()
        const namespace = c.get('namespace')
        const results: CursorImportRowOutcome[] = []
        for (const selection of parsed.selections) {
            // Always resolve through the online-machine gate — do not trust a
            // stale per-row machineId from a discovery snapshot after a runner drop.
            const machineId = resolveRequestedImportMachineId(
                selection.workspacePath,
                namespace,
                engine,
                selection.machineId ?? parsed.machineId
            )
            if (!machineId) {
                results.push({
                    ok: false,
                    uuid: selection.uuid,
                    reason: 'internal_error',
                    message: NO_ONLINE_MACHINE_ERROR,
                    durationMs: 0
                })
                continue
            }
            try {
                const outcome = await importCursorSelectionViaMachine({
                    engine,
                    store: options.store,
                    namespace,
                    machineId,
                    selection,
                    getSyncEngine: options.getSyncEngine
                })
                results.push(outcome)
            } catch (error) {
                results.push({
                    ok: false,
                    uuid: selection.uuid,
                    reason: 'internal_error',
                    message: error instanceof Error ? error.message : String(error),
                    durationMs: 0
                })
            }
        }
        const importedCount = results.filter((row) => row.ok).length

        appendImportLog(
            `imported=${importedCount}/${parsed.selections.length}; uuids=${parsed.selections.map((s) => s.uuid).join(',')}; outcomes=${results.map(rowToLog).join('|')}`
        )

        const response: CursorImportResponse = {
            success: true,
            results,
            importedCount
        }
        return c.json(response)
    })

    return app
}

function rowToLog(row: CursorImportRowOutcome): string {
    if (row.ok) {
        return `ok(${row.uuid}->${row.hapiSessionId} ${row.sourceFormat} ${row.durationMs}ms)`
    }
    return `fail(${row.uuid} ${row.reason} ${row.durationMs}ms)`
}

// Re-export for direct programmatic use from tests / future CLI subcommand.
export {
    listImportableCursorSessions,
    importSelectedCursorSessions,
    importCursorSession
} from '../../cursor/cursorImporter'

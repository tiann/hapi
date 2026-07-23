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
 *   GET  /api/cursor/importable-sessions  → list local cursor chats
 *   POST /api/cursor/import { selections[] } | { uuids[], workspacePath? } → import N rows
 *
 * Prefer `selections` (uuid + discovered workspacePath per row) so legacy
 * drawers stay resumable. `uuids` + optional global `workspacePath` remains
 * for older clients / tests.
 *
 * The strict ACP-only refusal contract lives in `cursorImporter.ts`.
 * This module is namespace-gated to `default` (matching codex), proxies
 * the importer's structured outcomes back to the dialog, and writes a
 * lightweight audit log line per import.
 */

import { Hono } from 'hono'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import {
    importSelectedCursorSessions,
    listImportableCursorSessions
} from '../../cursor/cursorImporter'
import type {
    CursorImportResponse,
    CursorImportRowOutcome,
    CursorImportableSessionsResponse
} from './_agentImport/types'

const CURSOR_IMPORT_NAMESPACE_ERROR = 'Cursor session import is not available outside the default namespace'
const NO_CURSOR_SESSION_SELECTED_ERROR = 'No cursor sessions selected for import'

function getHome(): string {
    return process.env.HAPI_CURSOR_HOME_OVERRIDE?.trim() || homedir()
}

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
    selections: Array<{ uuid: string; workspacePath: string | null }>
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

    if (Array.isArray(record.selections)) {
        const selections: Array<{ uuid: string; workspacePath: string | null }> = []
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
            seen.add(uuid)
            selections.push({
                uuid,
                workspacePath: rowPath.value ?? globalPath.value
            })
        }
        return { selections }
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
            workspacePath: globalPath.value
        }))
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

    app.get('/cursor/importable-sessions', (c) => {
        const home = getHome()
        const sessions = listImportableCursorSessions({
            store: options.store,
            namespace: c.get('namespace'),
            home
        })
        return c.json({
            success: true,
            sessions
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

        const home = getHome()
        const result = await importSelectedCursorSessions({
            selections: parsed.selections,
            store: options.store,
            namespace: c.get('namespace'),
            home,
            getSyncEngine: options.getSyncEngine
        })

        appendImportLog(
            `imported=${result.importedCount}/${parsed.selections.length}; uuids=${parsed.selections.map((s) => s.uuid).join(',')}; outcomes=${result.results.map(rowToLog).join('|')}`
        )

        const response: CursorImportResponse = {
            success: true,
            results: result.results,
            importedCount: result.importedCount
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
export { listImportableCursorSessions, importSelectedCursorSessions } from '../../cursor/cursorImporter'

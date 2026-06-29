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
 *   POST /api/cursor/import { uuids[], workspacePath? } → import N rows
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
    uuids: string[]
    workspacePath: string | null
    error?: string
}

function parseImportRequest(body: unknown): CursorImportRequestParseResult {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { uuids: [], workspacePath: null }
    }
    const record = body as Record<string, unknown>
    const rawUuids = record.uuids
    let uuids: string[] = []
    if (Array.isArray(rawUuids)) {
        for (const value of rawUuids) {
            if (typeof value !== 'string') {
                return { uuids: [], workspacePath: null, error: 'Invalid uuids' }
            }
            const trimmed = value.trim()
            if (trimmed) uuids.push(trimmed)
        }
    } else if (rawUuids !== undefined) {
        return { uuids: [], workspacePath: null, error: 'Invalid uuids' }
    }
    uuids = Array.from(new Set(uuids))

    let workspacePath: string | null = null
    if (typeof record.workspacePath === 'string') {
        const trimmed = record.workspacePath.trim()
        workspacePath = trimmed.length > 0 ? trimmed : null
    } else if (record.workspacePath != null && record.workspacePath !== undefined) {
        return { uuids: [], workspacePath: null, error: 'Invalid workspacePath' }
    }

    return { uuids, workspacePath }
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
        if (parsed.uuids.length === 0) {
            appendImportLog(`FAILED: ${NO_CURSOR_SESSION_SELECTED_ERROR}`)
            return c.json({
                success: false,
                error: NO_CURSOR_SESSION_SELECTED_ERROR
            }, 400)
        }

        const home = getHome()
        const result = await importSelectedCursorSessions({
            uuids: parsed.uuids,
            workspacePath: parsed.workspacePath,
            store: options.store,
            namespace: c.get('namespace'),
            home,
            getSyncEngine: options.getSyncEngine
        })

        appendImportLog(
            `imported=${result.importedCount}/${parsed.uuids.length}; uuids=${parsed.uuids.join(',')}; outcomes=${result.results.map(rowToLog).join('|')}`
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

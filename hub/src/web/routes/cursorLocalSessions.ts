/**
 * Cursor local-session import routes on the #2435 registry surface.
 *
 * REST pair matches other flavors (`/api/cursor/sessions`,
 * `/api/cursor/import-sessions`). List uses ListLocalSessions; import runs
 * PrepareCursorImport (ACP verify + legacy transplant) then creates an
 * attach-only HAPI row — Cursor scrollback comes from ACP resume, not
 * message backfill.
 */

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'

import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import {
    buildAlreadyImportedCursorIndex,
    buildImportedCursorSessionMetadata
} from '../../cursor/cursorImportMetadata'
import { pickImportMachine } from './localSessions/machinePick'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'

const CURSOR_IMPORT_NAMESPACE_ERROR = 'Cursor session import is not available outside the default namespace'
const NO_CURSOR_SESSION_SELECTED_ERROR = 'No Cursor sessions selected'
const NO_ONLINE_MACHINE_ERROR = 'No online machine available for Cursor history import'
const IMPORT_LIMIT = 200

type CursorListItem = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    messageCount?: number
    hapiSessionId?: string
    sourceFormat?: string | null
    sizeBytes?: number | null
}

type CursorImportResult = {
    cursorSessionId: string
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

function resolveMachineHomeDir(engine: SyncEngine | null, machineId: string): string {
    const machine = engine?.getMachine(machineId)
    const recorded = machine?.metadata?.homeDir
    return typeof recorded === 'string' && recorded.trim().length > 0 ? recorded.trim() : ''
}

function machineSupportsCursorImport(machine: { metadata?: { capabilities?: readonly string[] | null } | null } | null | undefined): boolean {
    return machine?.metadata?.capabilities?.includes(MACHINE_CAPABILITIES.LocalSessionImport) === true
}

export function createCursorLocalSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/cursor/*', async (c, next) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ success: false, error: CURSOR_IMPORT_NAMESPACE_ERROR, sessions: [] }, 403)
        }
        return next()
    })

    app.get('/cursor/sessions', async (c) => {
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const cwd = c.req.query('cwd')?.trim() || null
        const machine = pickImportMachine({
            engine,
            namespace,
            requestedMachineId: c.req.query('machineId')?.trim() || null,
            cwd
        })
        if (!machine) {
            return c.json({ success: false, error: NO_ONLINE_MACHINE_ERROR, sessions: [] }, 503)
        }
        if (!machineSupportsCursorImport(machine)) {
            return c.json({
                success: false,
                error: 'Cursor runner does not support local history import',
                sessions: [],
                machineId: machine.id
            }, 503)
        }
        const listed = await engine!.listLocalSessionsForMachine(machine.id, {
            flavor: 'cursor',
            cwd,
            sessionIds: null
        })
        if (!listed.success) {
            return c.json({
                success: false,
                error: listed.error,
                sessions: [],
                machineId: machine.id
            }, 503)
        }
        const already = buildAlreadyImportedCursorIndex(options.store, namespace)
        const sessions: CursorListItem[] = listed.sessions.map((summary) => {
            const extra = asRecord(summary.extra) ?? {}
            return {
                id: summary.id,
                title: summary.title,
                lastUserMessage: summary.lastUserMessage ?? null,
                cwd: summary.cwd ?? null,
                file: summary.file,
                modifiedAt: summary.modifiedAt,
                messageCount: summary.messageCount,
                hapiSessionId: already.get(summary.id),
                sourceFormat: typeof extra.sourceFormat === 'string' ? extra.sourceFormat : null,
                sizeBytes: typeof extra.sizeBytes === 'number' ? extra.sizeBytes : null
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/cursor/import-sessions', async (c) => {
        const namespace = c.get('namespace')
        const body = asRecord(await c.req.json().catch(() => null)) ?? {}
        const rawSessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : []
        if (rawSessionIds.length > IMPORT_LIMIT) {
            return c.json({
                success: false,
                error: `At most ${IMPORT_LIMIT} Cursor sessions can be imported at once`,
                results: []
            }, 400)
        }
        const sessionIds = [...new Set(
            rawSessionIds
                .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
                .map((id) => id.trim())
        )]
        if (sessionIds.length === 0) {
            return c.json({ success: false, error: NO_CURSOR_SESSION_SELECTED_ERROR, results: [] }, 400)
        }
        const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : null
        const engine = options.getSyncEngine()
        const machine = pickImportMachine({
            engine,
            namespace,
            requestedMachineId: typeof body.machineId === 'string' ? body.machineId.trim() : null,
            cwd
        })
        if (!engine || !machine) {
            return c.json({ success: false, error: NO_ONLINE_MACHINE_ERROR, results: [] }, 503)
        }
        if (!machineSupportsCursorImport(machine)) {
            return c.json({
                success: false,
                error: 'Cursor runner does not support local history import',
                results: [],
                machineId: machine.id
            }, 503)
        }

        const listed = await engine.listLocalSessionsForMachine(machine.id, {
            flavor: 'cursor',
            cwd,
            sessionIds: null
        })
        if (!listed.success) {
            return c.json({
                success: false,
                error: listed.error,
                results: [],
                machineId: machine.id
            }, 503)
        }
        const byId = new Map(listed.sessions.map((session) => [session.id, session]))
        const results: CursorImportResult[] = []

        for (const sessionId of sessionIds) {
            const already = buildAlreadyImportedCursorIndex(options.store, namespace).get(sessionId)
            if (already) {
                results.push({
                    cursorSessionId: sessionId,
                    hapiSessionId: already,
                    action: 'unchanged',
                    appended: 0
                })
                continue
            }
            const summary = byId.get(sessionId)
            if (!summary) {
                results.push({
                    cursorSessionId: sessionId,
                    error: { code: 'missing_on_disk_store', message: `Cursor session ${sessionId} was not found on the runner` }
                })
                continue
            }
            const workspacePath = summary.cwd ?? cwd
            const prepared = await engine.prepareCursorImportForMachine(machine.id, sessionId, workspacePath)
            if (!prepared.success) {
                results.push({
                    cursorSessionId: sessionId,
                    error: { code: prepared.reason, message: prepared.message }
                })
                continue
            }
            const alreadyAfter = buildAlreadyImportedCursorIndex(options.store, namespace).get(sessionId)
            if (alreadyAfter) {
                results.push({
                    cursorSessionId: sessionId,
                    hapiSessionId: alreadyAfter,
                    action: 'unchanged',
                    appended: 0
                })
                continue
            }
            try {
                const metadata = buildImportedCursorSessionMetadata({
                    uuid: prepared.uuid,
                    workspacePath: prepared.workspacePath,
                    title: prepared.title,
                    hostName: prepared.hostName,
                    homeDir: resolveMachineHomeDir(engine, machine.id),
                    machineId: machine.id
                })
                const created = engine.getOrCreateSession(randomUUID(), metadata, {}, namespace)
                results.push({
                    cursorSessionId: sessionId,
                    hapiSessionId: created.id,
                    action: 'created',
                    appended: 0
                })
            } catch (error) {
                results.push({
                    cursorSessionId: sessionId,
                    error: {
                        code: 'internal_error',
                        message: error instanceof Error ? error.message : String(error)
                    }
                })
            }
        }

        const success = results.every((row) => !row.error)
        return c.json({
            success,
            results,
            machineId: machine.id,
            ...(success ? {} : { error: results.find((row) => row.error)?.error?.message })
        })
    })

    return app
}

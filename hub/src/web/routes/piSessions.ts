import { Hono } from 'hono'
import type { PiLocalSessionSummary, PiLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { piToTranscript } from '@hapi/protocol/localTranscript'
import type { Store, StoredSession } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { runLocalImportSync } from './localSessions/importLocalTranscript'
import { PI_LOCAL_SESSION_SOURCE } from './localSessions/sources'

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
    requestedMachineId: string | null
): Machine | null {
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (requestedMachineId) {
        return online.find((machine) => machine.id === requestedMachineId) ?? null
    }
    return online[0] ?? null
}

function importedPiSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const imported = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = storedMetadata(session)
        if (metadata.flavor !== 'pi' || metadata.machineId !== machineId) continue
        if (typeof metadata.piSessionId !== 'string' || imported.has(metadata.piSessionId)) continue
        imported.set(metadata.piSessionId, session)
    }
    return imported
}

/**
 * Import one Pi transcript through the generic importer. The
 * generic route path is importLocalTranscript directly; this wrapper stays
 * synchronous for the legacy route, which never passes request launch config.
 */
export function importPiSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: PiLocalSessionWithMessages
    existingSession?: StoredSession | null
}): PiImportResult {
    const outcome = runLocalImportSync({
        store: options.store,
        engine: options.engine,
        namespace: options.namespace,
        source: PI_LOCAL_SESSION_SOURCE,
        transcript: piToTranscript(options.transcript),
        machine: options.machine,
        ...(options.existingSession !== undefined ? { existingSession: options.existingSession } : {})
    })
    return {
        piSessionId: outcome.sessionId,
        ...(outcome.hapiSessionId !== undefined ? { hapiSessionId: outcome.hapiSessionId } : {}),
        ...(outcome.action !== undefined ? { action: outcome.action } : {}),
        ...(outcome.appended !== undefined ? { appended: outcome.appended } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {})
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
            results.push(importPiSession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript,
                existingSession: importedByPiId.get(sessionId) ?? null
            }))
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}
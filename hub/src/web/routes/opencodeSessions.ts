import { Hono } from 'hono'
import { MAX_OPENCODE_SESSION_IMPORTS } from '@hapi/protocol/apiTypes'
import type { OpencodeLocalSessionSummary, OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol/modes'
import type { PermissionMode } from '@hapi/protocol/modes'
import { opencodeToTranscript } from '@hapi/protocol/localTranscript'
import type { Store, StoredSession } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { importLocalTranscript, type LocalImportLaunchConfig } from './localSessions/importLocalTranscript'
import { OPENCODE_LOCAL_SESSION_SOURCE } from './localSessions/sources'

export type OpencodeSessionListItem = OpencodeLocalSessionSummary & {
    hapiSessionId?: string
}

export type OpencodeImportResult = {
    opencodeSessionId: string
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

function resolveOpencodeMachine(
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

function importedOpencodeSessionsById(
    store: Store,
    namespace: string,
    machineId: string
): Map<string, StoredSession> {
    const imported = new Map<string, StoredSession>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        const metadata = asRecord(session.metadata)
        if (metadata?.flavor !== 'opencode' || metadata.machineId !== machineId) continue
        if (typeof metadata.opencodeSessionId !== 'string' || imported.has(metadata.opencodeSessionId)) continue
        imported.set(metadata.opencodeSessionId, session)
    }
    return imported
}

/**
 * Import one OpenCode transcript through the generic importer. The generic
 * route path is importLocalTranscript directly; this wrapper routes the
 * legacy route through the same locked async envelope so the request launch
 * config applies inside the per-native-session lock (a config failure comes
 * back as a per-session config_failed result).
 */
export async function importOpencodeSession(options: {
    store: Store
    engine: SyncEngine
    namespace: string
    machine: Machine
    transcript: OpencodeLocalSessionWithMessages
    existingSession?: StoredSession | null
    launch?: LocalImportLaunchConfig
}): Promise<OpencodeImportResult> {
    const outcome = await importLocalTranscript({
        store: options.store,
        engine: options.engine,
        namespace: options.namespace,
        source: OPENCODE_LOCAL_SESSION_SOURCE,
        transcript: opencodeToTranscript(options.transcript),
        machine: options.machine,
        ...(options.launch ? { request: { launch: options.launch } } : {}),
        ...(options.existingSession !== undefined ? { existingSession: options.existingSession } : {})
    })
    return {
        opencodeSessionId: outcome.sessionId,
        ...(outcome.hapiSessionId !== undefined ? { hapiSessionId: outcome.hapiSessionId } : {}),
        ...(outcome.action !== undefined ? { action: outcome.action } : {}),
        ...(outcome.appended !== undefined ? { appended: outcome.appended } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {})
    }
}

export function createOpencodeSessionRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/opencode/sessions', async (c) => {
        const namespace = c.get('namespace')
        const machine = resolveOpencodeMachine(options.getSyncEngine(), namespace, c.req.query('machineId')?.trim() || null)
        if (!machine) return c.json({ success: false, error: 'No online machine available for OpenCode history import', sessions: [] }, 503)
        const result = await options.getSyncEngine()!.listOpencodeSessionsForMachine(machine.id, c.req.query('cwd')?.trim() || null)
        if (!result.success) return c.json({ success: false, error: result.error, sessions: [], machineId: machine.id }, 503)
        const importedByOpencodeId = importedOpencodeSessionsById(options.store, namespace, machine.id)
        const sessions: OpencodeSessionListItem[] = result.sessions.map((summary) => {
            const imported = importedByOpencodeId.get(summary.id)
            return {
                ...summary,
                ...(imported ? { hapiSessionId: imported.id } : {})
            }
        })
        return c.json({ success: true, sessions, machineId: machine.id })
    })

    app.post('/opencode/import-sessions', async (c) => {
        const body = asRecord(await c.req.json().catch(() => null))
        const rawSessionIds = Array.isArray(body?.sessionIds) ? body.sessionIds : []
        if (rawSessionIds.length > MAX_OPENCODE_SESSION_IMPORTS) {
            return c.json({ success: false, error: `At most ${MAX_OPENCODE_SESSION_IMPORTS} OpenCode sessions can be imported at once`, results: [] }, 400)
        }
        const sessionIds = rawSessionIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .map((id) => id.trim())
        if (sessionIds.length === 0) return c.json({ success: false, error: 'No OpenCode sessions selected', results: [] }, 400)
        const uniqueSessionIds = [...new Set(sessionIds)]
        const namespace = c.get('namespace')
        const engine = options.getSyncEngine()
        const machine = resolveOpencodeMachine(engine, namespace, typeof body?.machineId === 'string' ? body.machineId.trim() : null)
        if (!engine || !machine) return c.json({ success: false, error: 'No online machine available for OpenCode history import', results: [] }, 503)
        const remote = await engine.listOpencodeSessionsForMachine(
            machine.id,
            typeof body?.cwd === 'string' ? body.cwd.trim() : null,
            uniqueSessionIds
        )
        if (!remote.success) return c.json({ success: false, error: remote.error, results: [], machineId: machine.id }, 503)
        const byId = new Map(remote.sessions
            .filter((session): session is OpencodeLocalSessionWithMessages => 'messages' in session)
            .map((session) => [session.id, session]))
        const requestedModel = typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : null
        const requestedModelReasoningEffort = typeof body?.modelReasoningEffort === 'string' && body.modelReasoningEffort.trim().length > 0
            ? body.modelReasoningEffort.trim()
            : null
        const requestedPermissionMode = typeof body?.permissionMode === 'string' && body.permissionMode.trim().length > 0
            ? body.permissionMode.trim()
            : null
        if (requestedPermissionMode && !isPermissionModeAllowedForFlavor(requestedPermissionMode as PermissionMode, 'opencode')) {
            return c.json({ success: false, error: 'Invalid permission mode for OpenCode sessions', results: [] }, 400)
        }
        type LaunchConfig = Parameters<SyncEngine['applySessionConfig']>[1]
        const launch: LocalImportLaunchConfig = {}
        const hasLaunchKey = (key: string): boolean => Object.prototype.hasOwnProperty.call(body ?? {}, key)
        // Property presence matters: applySessionConfig only resets a persisted
        // value when the key is present, so explicit nulls / 'default' must be
        // preserved to clear stale selections on re-import.
        if (hasLaunchKey('model')) launch.model = requestedModel
        if (hasLaunchKey('modelReasoningEffort')) launch.modelReasoningEffort = requestedModelReasoningEffort
        if (hasLaunchKey('permissionMode')) launch.permissionMode = (requestedPermissionMode ?? 'default') as PermissionMode
        const results: OpencodeImportResult[] = []
        for (const sessionId of uniqueSessionIds) {
            const transcript = byId.get(sessionId)
            if (!transcript) {
                results.push({ opencodeSessionId: sessionId, error: { code: 'not_found', message: 'OpenCode session transcript not found' } })
                continue
            }
            // Import + config apply run inside the importer's per-native-session
            // lock, so a concurrent import of the same transcript waits for the
            // whole envelope instead of racing the launch-config writes.
            const imported = await importOpencodeSession({
                store: options.store,
                engine,
                namespace,
                machine,
                transcript,
                ...(Object.keys(launch).length > 0 ? { launch } : {})
            })
            results.push(imported)
        }
        return c.json({ success: results.every((result) => !result.error), results, machineId: machine.id })
    })

    return app
}
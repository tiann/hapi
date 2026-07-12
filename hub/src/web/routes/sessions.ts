import {
    CursorMigrateToAcpRequestSchema,
    DeleteUploadRequestSchema,
    getPermissionModesForFlavor,
    isPermissionModeAllowedForFlavor,
    RenameSessionRequestSchema,
    ResumeSessionRequestSchema,
    SessionCollaborationModeRequestSchema,
    SessionEffortRequestSchema,
    SessionModelReasoningEffortRequestSchema,
    SessionServiceTierRequestSchema,
    SessionModelRequestSchema,
    SessionPermissionModeRequestSchema,
    supportsModelChange,
    supportsEffort,
    toSessionSummary,
    UploadFileRequestSchema
} from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { SlashCommand } from '@hapi/protocol/apiTypes'
import { Hono, type Context } from 'hono'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

function commandsFromMetadataSlashCommands(names: readonly string[] | undefined): SlashCommand[] {
    if (!names?.length) {
        return []
    }

    return names
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => ({
            name,
            source: 'builtin'
        }))
}

function mergeSlashCommands(
    primary: readonly SlashCommand[],
    fallback: readonly SlashCommand[]
): SlashCommand[] {
    const commandMap = new Map<string, SlashCommand>()
    for (const command of [...fallback, ...primary]) {
        commandMap.set(command.name, command)
    }
    return Array.from(commandMap.values())
}

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

export function createSessionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const getPendingCount = (s: Session) => s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0

        const namespace = c.get('namespace')
        const sessionRecords = engine.getSessionsByNamespace(namespace)
            .sort((a, b) => {
                // Active sessions first
                if (a.active !== b.active) {
                    return a.active ? -1 : 1
                }
                // Within active sessions, sort by pending requests count
                const aPending = getPendingCount(a)
                const bPending = getPendingCount(b)
                if (a.active && aPending !== bPending) {
                    return bPending - aPending
                }
                // Then by updatedAt
                return b.updatedAt - a.updatedAt
            })
        const scheduledCounts = engine.getFutureScheduledMessageCounts(sessionRecords.map((session) => session.id))
        const nextScheduledAt = engine.getNextScheduledAtBySessionIds(sessionRecords.map((session) => session.id))
        const sessions = sessionRecords.map((session) => {
            const summary = toSessionSummary(session)
            return {
                ...summary,
                futureScheduledMessageCount: scheduledCounts.get(session.id) ?? 0,
                nextScheduledAt: nextScheduledAt.get(session.id) ?? null
            }
        })

        return c.json({ sessions })
    })

    app.get('/sessions/:id/export', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const result = engine.getSessionExport(sessionResult.sessionId, sessionResult.session)
        if (result.type === 'too-large') {
            return c.json({
                error: 'Session export too large',
                count: result.count,
                limit: result.limit
            }, 413)
        }

        return c.json(result.payload)
    })

    app.get('/sessions/:id', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        return c.json({ session: sessionResult.session })
    })

    app.post('/sessions/:id/resume', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = body ? ResumeSessionRequestSchema.safeParse(body) : { success: true as const, data: {} }
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const { permissionMode } = parsed.data
        if (permissionMode !== undefined) {
            const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
            if (!isPermissionModeAllowedForFlavor(permissionMode, flavor)) {
                return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
            }
        }

        const namespace = c.get('namespace')
        const result = await engine.resumeSession(
            sessionResult.sessionId,
            namespace,
            permissionMode !== undefined ? { permissionMode } : undefined
        )
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'resume_unavailable' ? 409
                            : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/sessions/:id/reopen', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: false })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const namespace = c.get('namespace')
        const result = await engine.reopenSession(sessionResult.sessionId, namespace)

        if (result.type === 'incomplete') {
            return c.json({ error: result.message, missing: result.missing }, 422)
        }

        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503
                : result.code === 'access_denied' ? 403
                    : result.code === 'session_not_found' ? 404
                        : result.code === 'resume_unavailable' ? 409
                            : result.code === 'metadata_conflict' ? 409
                                : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({
            ok: true,
            sessionId: result.sessionId,
            resumed: result.resumed,
            ...(result.cursorSessionProtocol ? { cursorSessionProtocol: result.cursorSessionProtocol } : {})
        })
    })

    app.post('/sessions/:id/upload', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = UploadFileRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const estimatedBytes = estimateBase64Bytes(parsed.data.content)
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
            return c.json({ success: false, error: 'File too large (max 50MB)' }, 413)
        }

        try {
            const result = await engine.uploadFile(
                sessionResult.sessionId,
                parsed.data.filename,
                parsed.data.content,
                parsed.data.mimeType
            )
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to upload file'
            }, 500)
        }
    })

    app.post('/sessions/:id/upload/delete', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = DeleteUploadRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.deleteUploadFile(sessionResult.sessionId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete upload'
            }, 500)
        }
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.abortSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/archive', async (c) => {
        // tiann/hapi#916: relax the blanket `requireActive: true` guard so
        // the endpoint is idempotent for already-archived rows AND can clean
        // up split-brain rows after a hub-restart cascade (inactive in cache
        // but metadata.lifecycleState still 'running'). Normal inactive rows
        // that are not archived (completed stubs, UI Delete/Reopen targets)
        // keep the old 409 contract.
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const lifecycleState = sessionResult.session.metadata?.lifecycleState
        if (lifecycleState === 'archived') {
            return c.json({ ok: true, alreadyArchived: true })
        }

        if (!sessionResult.session.active && lifecycleState !== 'running') {
            return c.json({ error: 'Session is inactive' }, 409)
        }

        await engine.archiveSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/migrate-to-acp', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Codex #34 P2 (round 13): `c.req.json().catch(() => ({}))` silently
        // converts malformed JSON into an empty object — which then passes
        // CursorMigrateToAcpRequestSchema (all fields optional) and runs
        // the migration with DESTRUCTIVE defaults (keepSource defaults to
        // remove-after-flip). An operator who intended `{"keepSource": true}`
        // but sent a truncated body would see the legacy store removed
        // anyway. Distinguish "no body at all" (defaults are fine) from
        // "malformed JSON" (reject with 400).
        const rawBody = await c.req.text()
        let body: unknown = {}
        if (rawBody.trim().length > 0) {
            try {
                body = JSON.parse(rawBody)
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400)
            }
        }
        const parsed = CursorMigrateToAcpRequestSchema.safeParse(body ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace')
        const outcome = await engine.migrateLegacyCursorSession(
            sessionResult.sessionId,
            namespace,
            parsed.data
        )
        const status = outcome.ok ? 200
            : outcome.reason === 'already_acp' || outcome.reason === 'not_cursor_session' || outcome.reason === 'no_cursor_session_id' ? 409
                : outcome.reason === 'running_refused' ? 409
                    : outcome.reason === 'target_already_exists' ? 409
                        : outcome.reason === 'no_legacy_store_on_disk' ? 404
                            : 500
        return c.json(outcome, status)
    })

    app.post('/sessions/:id/switch', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.switchSession(sessionResult.sessionId, 'remote')
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/permission-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionPermissionModeRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        const mode = parsed.data.mode

        const allowedModes = getPermissionModesForFlavor(flavor)
        if (allowedModes.length === 0) {
            return c.json({ error: 'Permission mode not supported for session flavor' }, 400)
        }

        if (!isPermissionModeAllowedForFlavor(mode, flavor)) {
            return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
        }
        if (flavor === 'opencode' && mode === 'plan' && sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'OpenCode plan mode is only supported for remote sessions' }, 409)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { permissionMode: mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply permission mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/collaboration-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({ error: 'Collaboration mode is only supported for Codex sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Collaboration mode can only be changed for remote Codex sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionCollaborationModeRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { collaborationMode: parsed.data.mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply collaboration mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionModelRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!supportsModelChange(flavor)) {
            return c.json({ error: 'Model selection is not supported for this session' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            if (flavor === 'codex') {
                return c.json({ error: 'Model selection can only be changed for remote Codex sessions' }, 409)
            }
            if (flavor === 'cursor') {
                return c.json({ error: 'Model selection can only be changed for remote Cursor sessions' }, 409)
            }
            if (flavor === 'grok') {
                return c.json({ error: 'Model selection can only be changed for remote Grok sessions' }, 409)
            }
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { model: parsed.data.model })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model-reasoning-effort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex' && flavor !== 'opencode') {
            return c.json({ error: 'Model reasoning effort is only supported for Codex and OpenCode sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Model reasoning effort can only be changed for remote sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionModelReasoningEffortRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                modelReasoningEffort: parsed.data.modelReasoningEffort
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model reasoning effort'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/effort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionEffortRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!supportsEffort(flavor)) {
            return c.json({ error: 'Effort selection is not supported for this session type' }, 400)
        }
        if (flavor === 'grok' && sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Effort can only be changed for remote Grok sessions' }, 409)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { effort: parsed.data.effort })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply effort'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/service-tier', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({ error: 'Fast mode is only supported for Codex sessions' }, 400)
        }
        if (sessionResult.session.agentState?.controlledByUser === true) {
            return c.json({ error: 'Fast mode can only be changed for remote sessions' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SessionServiceTierRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                serviceTier: parsed.data.serviceTier
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply service tier'
            return c.json({ error: message }, 409)
        }
    })

    app.patch('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = RenameSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body: name is required' }, 400)
        }

        try {
            await engine.renameSession(sessionResult.sessionId, parsed.data.name)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to rename session'
            // Map concurrency/version errors to 409 conflict
            if (message.includes('concurrently') || message.includes('version')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.delete('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        if (sessionResult.session.active) {
            return c.json({ error: 'Cannot delete active session. Archive it first.' }, 409)
        }

        try {
            await engine.deleteSession(sessionResult.sessionId)
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to delete session'
            // Map "active session" error to 409 conflict (race condition: session became active)
            if (message.includes('active')) {
                return c.json({ error: message }, 409)
            }
            return c.json({ error: message }, 500)
        }
    })

    app.get('/sessions/:id/slash-commands', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Get agent type from session metadata, default to 'claude'
        const agent = sessionResult.session.metadata?.flavor ?? 'claude'

        const metadataCommands = commandsFromMetadataSlashCommands(
            sessionResult.session.metadata?.slashCommands
        )

        try {
            const result = await engine.listSlashCommands(sessionResult.sessionId, agent)
            if (result.success && result.commands) {
                return c.json({
                    ...result,
                    commands: mergeSlashCommands(result.commands, metadataCommands)
                })
            }

            if (metadataCommands.length > 0) {
                return c.json({ success: true, commands: metadataCommands })
            }

            return c.json(result)
        } catch (error) {
            if (metadataCommands.length > 0) {
                return c.json({ success: true, commands: metadataCommands })
            }

            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list slash commands'
            })
        }
    })

    app.get('/sessions/:id/skills', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        try {
            const result = await engine.listSkills(
                sessionResult.sessionId,
                sessionResult.session.metadata?.flavor ?? 'claude'
            )
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list skills'
            })
        }
    })

    app.get('/sessions/:id/codex-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'codex') {
            return c.json({
                success: false,
                error: 'Codex models are only available for Codex sessions'
            }, 400)
        }

        try {
            const result = await engine.listCodexModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/sessions/:id/opencode-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'opencode') {
            return c.json({
                success: false,
                error: 'OpenCode models are only available for OpenCode sessions'
            }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/sessions/:id/opencode-reasoning-effort-options', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'opencode') {
            return c.json({
                success: false,
                error: 'OpenCode reasoning effort options are only available for OpenCode sessions'
            }, 400)
        }

        try {
            const result = await engine.listOpencodeReasoningEffortOptionsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode reasoning effort options'
            }, 500)
        }
    })

    app.get('/sessions/:id/grok-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'grok') {
            return c.json({ success: false, error: 'Grok models are only available for Grok sessions' }, 400)
        }
        try {
            return c.json(await engine.listGrokModelsForSession(sessionResult.sessionId))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/sessions/:id/grok-reasoning-effort-options', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult
        if (sessionResult.session.metadata?.flavor !== 'grok') {
            return c.json({ success: false, error: 'Grok effort options are only available for Grok sessions' }, 400)
        }
        try {
            return c.json(await engine.listGrokReasoningEffortOptionsForSession(sessionResult.sessionId))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok effort options'
            }, 500)
        }
    })

    app.get('/sessions/:id/cursor-models', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'cursor') {
            return c.json({
                success: false,
                error: 'Cursor models are only available for Cursor sessions'
            }, 400)
        }

        try {
            const result = await engine.listCursorModelsForSession(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    // Helper: guard + flavor check + error handling for Pi session endpoints
    async function withPiSession(
        c: Context<WebAppEnv>,
        handler: (ctx: { sessionId: string; engine: SyncEngine }) => Promise<Response>
    ): Promise<Response> {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) return sessionResult

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'pi') {
            return c.json({ success: false, error: 'Not a Pi session' }, 400)
        }

        try {
            return await handler({ sessionId: sessionResult.sessionId, engine })
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Internal error'
            }, 500)
        }
    }

    // --- Pi models ---
    app.get('/sessions/:id/pi-models', (c) =>
        withPiSession(c, async ({ sessionId, engine }) =>
            c.json(await engine.callPiRpc(sessionId, RPC_METHODS.ListPiModels, {}, 120_000))
        )
    )

    return app
}

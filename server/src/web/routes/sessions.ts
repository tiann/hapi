import { getPermissionModesForFlavor, isModelModeAllowedForFlavor, isPermissionModeAllowedForFlavor, toSessionSummary } from '@hapi/protocol'
import { ModelModeSchema, PermissionModeSchema } from '@hapi/protocol/schemas'
import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine, Session } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const permissionModeSchema = z.object({
    mode: PermissionModeSchema
})

const modelModeSchema = z.object({
    model: ModelModeSchema
})

const renameSessionSchema = z.object({
    name: z.string().min(1).max(255)
})

const uploadSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

const uploadDeleteSchema = z.object({
    path: z.string().min(1)
})

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

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
        const sessions = engine.getSessionsByNamespace(namespace)
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
            .map(toSessionSummary)

        return c.json({ sessions })
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
        const parsed = uploadSchema.safeParse(body)
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
        const parsed = uploadDeleteSchema.safeParse(body)
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
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.archiveSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    /**
     * Resume an inactive session.
     *
     * **Session ID Note:**
     * The :id parameter is the hapi session ID (visible in the UI/URL).
     * This is NOT the Claude session ID.
     *
     * This endpoint will:
     * 1. Try to reconnect to existing CLI process via RPC (if still running)
     * 2. If RPC fails, spawn new CLI with --resume flag
     * 3. Keep same hapi session ID throughout (no redirect)
     * 4. Claude may create new Claude session ID (stored in metadata)
     *
     * **Concurrency Protection:**
     * Multiple simultaneous resume requests for the same session will be
     * deduplicated - only one resume operation will run, others will wait
     * for it to complete.
     */
    app.post('/sessions/:id/resume', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        console.log('[POST /sessions/:id/resume] Resume request:', {
            sessionId: sessionResult.sessionId,
            isActive: sessionResult.session.active
        })

        if (sessionResult.session.active) {
            return c.json({ error: 'Session is already active' }, 409)
        }

        try {
            await engine.resumeSession(sessionResult.sessionId)
            console.log('[POST /sessions/:id/resume] Resume successful:', {
                sessionId: sessionResult.sessionId
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to resume session'

            // Map specific errors to appropriate HTTP status codes
            if (message === 'Session not found') {
                return c.json({ error: message }, 404)
            }
            if (message === 'Session is already active') {
                return c.json({ error: message }, 409)
            }
            if (message.includes('No Claude session ID')) {
                return c.json({
                    error: 'Cannot resume: Session has no history. Please create a new session.'
                }, 400)
            }
            if (message.includes('RPC handler not registered') || message.includes('RPC socket disconnected')) {
                return c.json({
                    error: 'Cannot resume session: Session is not currently running. Please start a new session.'
                }, 409)
            }
            if (message.includes('Timeout')) {
                return c.json({
                    error: 'Cannot resume session: Connection to session lost. The session may have terminated.'
                }, 504)
            }

            // Generic server error for other cases
            return c.json({ error: message }, 500)
        }
    })

    /**
     * Fork a session (Claude only).
     *
     * Creates a new inactive session from an existing one, copying conversation history.
     * Only supported for Claude sessions - returns 501 for codex/gemini.
     */
    app.post('/sessions/:id/fork', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Check if fork is supported for this flavor
        if (sessionResult.session.metadata?.flavor !== 'claude') {
            return c.json({
                error: 'Fork is only supported for Claude sessions',
                flavor: sessionResult.session.metadata?.flavor
            }, 501)
        }

        const enableYolo = c.req.query('yolo') === 'true'

        try {
            // Create new session with forked metadata
            const newSessionId = await engine.forkSession(sessionResult.sessionId, enableYolo)

            return c.json({
                id: newSessionId,
                message: 'Session forked. Resume to activate.'
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to fork session'

            if (message === 'Source session not found') {
                return c.json({ error: message }, 404)
            }
            if (message.includes('Cannot fork: No Claude session ID')) {
                return c.json({ error: message }, 400)
            }

            return c.json({ error: message }, 500)
        }
    })

    /**
     * Reload a session.
     *
     * Gracefully terminates and immediately resumes the session.
     * Useful for reloading configuration or updating CLI version.
     */
    app.post('/sessions/:id/reload', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const force = c.req.query('force') === 'true'
        const enableYolo = c.req.query('yolo') === 'true'

        // Check if busy (unless force is true)
        if (!force) {
            const isBusy = engine.isSessionBusy(sessionResult.sessionId)
            if (isBusy) {
                return c.json({
                    error: 'Session is busy',
                    busy: true,
                    canForce: true
                }, 409)
            }
        }

        try {
            // Terminate and resume
            await engine.reloadSession(sessionResult.sessionId, force, enableYolo)

            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to reload session'

            if (message === 'Session not found') {
                return c.json({ error: message }, 404)
            }
            if (message === 'Session is not active') {
                return c.json({ error: message }, 409)
            }

            return c.json({ error: message }, 500)
        }
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

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = permissionModeSchema.safeParse(body)
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

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { permissionMode: mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply permission mode'
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
        const parsed = modelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (!isModelModeAllowedForFlavor(parsed.data.model, flavor)) {
            return c.json({ error: 'Model mode is only supported for Claude sessions' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { modelMode: parsed.data.model })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model mode'
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
        const parsed = renameSessionSchema.safeParse(body)
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

        try {
            const result = await engine.listSlashCommands(sessionResult.sessionId, agent)
            return c.json(result)
        } catch (error) {
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
            const result = await engine.listSkills(sessionResult.sessionId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list skills'
            })
        }
    })

    return app
}

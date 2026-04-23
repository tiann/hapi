import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSyncEngine } from './guards'

const querySchema = z.object({
    agent: z.union([z.literal('codex'), z.literal('claude')])
})

export function createImportableSessionsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    function mapActionErrorStatus(code: string): number {
        if (code === 'no_machine_online') return 503
        if (code === 'session_not_found') return 404
        if (code === 'access_denied') return 403
        return 500
    }

    app.get('/importable-sessions', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const parsed = querySchema.safeParse({
            agent: c.req.query('agent')
        })
        if (!parsed.success) {
            return c.json({ error: 'Invalid agent' }, 400)
        }

        const namespace = c.get('namespace')
        const result = parsed.data.agent === 'codex'
            ? await engine.listImportableCodexSessions(namespace)
            : await engine.listImportableClaudeSessions(namespace)
        if (result.type === 'error') {
            const status = result.code === 'no_machine_online' ? 503 : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        const sessions = result.sessions.map((session) => {
            const existing = parsed.data.agent === 'codex'
                ? engine.findSessionByExternalCodexSessionId(namespace, session.externalSessionId)
                : engine.findSessionByExternalClaudeSessionId(namespace, session.externalSessionId)
            return {
                ...session,
                alreadyImported: Boolean(existing),
                importedHapiSessionId: existing?.sessionId ?? null
            }
        })

        return c.json({ sessions })
    })

    app.post('/importable-sessions/codex/:externalSessionId/import', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const externalSessionId = c.req.param('externalSessionId')
        const result = await engine.importExternalCodexSession(externalSessionId, namespace)
        if (result.type === 'error') {
            return c.json({ error: result.message, code: result.code }, mapActionErrorStatus(result.code) as never)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/importable-sessions/codex/:externalSessionId/refresh', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const externalSessionId = c.req.param('externalSessionId')
        const result = await engine.refreshExternalCodexSession(externalSessionId, namespace)
        if (result.type === 'error') {
            return c.json({ error: result.message, code: result.code }, mapActionErrorStatus(result.code) as never)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/importable-sessions/claude/:externalSessionId/import', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const externalSessionId = c.req.param('externalSessionId')
        const result = await engine.importExternalClaudeSession(externalSessionId, namespace)
        if (result.type === 'error') {
            return c.json({ error: result.message, code: result.code }, mapActionErrorStatus(result.code) as never)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    app.post('/importable-sessions/claude/:externalSessionId/refresh', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const namespace = c.get('namespace')
        const externalSessionId = c.req.param('externalSessionId')
        const result = await engine.refreshExternalClaudeSession(externalSessionId, namespace)
        if (result.type === 'error') {
            return c.json({ error: result.message, code: result.code }, mapActionErrorStatus(result.code) as never)
        }

        return c.json({ type: 'success', sessionId: result.sessionId })
    })

    return app
}

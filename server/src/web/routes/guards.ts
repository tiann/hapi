import type { Context } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

export function requireSyncEngine(
    c: Context<WebAppEnv>,
    getSyncEngine: () => SyncEngine | null
): SyncEngine | Response {
    const engine = getSyncEngine()
    if (!engine) {
        return c.json({ error: 'Not connected' }, 503)
    }
    return engine
}

export function requireSession(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    sessionId: string,
    options?: { requireActive?: boolean }
): Session | Response {
    const session = engine.getSession(sessionId)
    if (!session) {
        return c.json({ error: 'Session not found' }, 404)
    }
    if (options?.requireActive && !session.active) {
        return c.json({ error: 'Session is inactive' }, 409)
    }
    return session
}

export function requireSessionFromParam(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    options?: { paramName?: string; requireActive?: boolean }
): { sessionId: string; session: Session } | Response {
    const paramName = options?.paramName ?? 'id'
    const sessionId = c.req.param(paramName)
    const session = requireSession(c, engine, sessionId, { requireActive: options?.requireActive })
    if (session instanceof Response) {
        return session
    }
    return { sessionId, session }
}


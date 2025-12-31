import type { Context } from 'hono'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
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
    const namespace = c.get('namespace')
    const session = engine.getSession(sessionId)
    if (!session) {
        return c.json({ error: 'Session not found' }, 404)
    }
    if (session.namespace !== namespace) {
        return c.json({ error: 'Session access denied' }, 403)
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

export function requireMachine(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    machineId: string
): Machine | Response {
    const namespace = c.get('namespace')
    const machine = engine.getMachine(machineId)
    if (!machine) {
        return c.json({ error: 'Machine not found' }, 404)
    }
    if (machine.namespace !== namespace) {
        return c.json({ error: 'Machine access denied' }, 403)
    }
    return machine
}

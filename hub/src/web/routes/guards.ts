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
): { sessionId: string; session: Session } | Response {
    const namespace = c.get('namespace')
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (!access.ok) {
        const status = access.reason === 'access-denied' ? 403 : 404
        const error = access.reason === 'access-denied' ? 'Session access denied' : 'Session not found'
        return c.json({ error }, status)
    }
    if (options?.requireActive && !access.session.active) {
        // `code` lets the web client discriminate the inactive-session 409 from
        // other 4xx without string-matching the human message (which is i18n'd
        // by the consumer and may change).  See web onError handler in
        // router.tsx which surfaces a Reopen affordance on this code.
        return c.json({ error: 'Session is inactive', code: 'session_inactive' }, 409)
    }
    return { sessionId: access.sessionId, session: access.session }
}

export function requireSessionFromParam(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    options?: { paramName?: string; requireActive?: boolean }
): { sessionId: string; session: Session } | Response {
    const paramName = options?.paramName ?? 'id'
    const sessionId = c.req.param(paramName)
    const result = requireSession(c, engine, sessionId, { requireActive: options?.requireActive })
    if (result instanceof Response) {
        return result
    }
    return result
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

import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional()
})

const sendMessageBodySchema = z.object({
    text: z.string().min(1),
    localId: z.string().min(1).optional()
})

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = querySchema.safeParse(c.req.query())
        const limit = parsed.success ? (parsed.data.limit ?? 50) : 50
        const beforeSeq = parsed.success ? (parsed.data.beforeSeq ?? null) : null
        return c.json(engine.getMessagesPage(sessionId, { limit, beforeSeq }))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'
        
        if (DEBUG) {
            console.log('[DEBUG] POST /sessions/:id/messages called')
        }
        
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            if (DEBUG) console.log('[DEBUG] No SyncEngine available')
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            if (DEBUG) console.log('[DEBUG] Session not found or not active')
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        if (DEBUG) {
            console.log('[DEBUG] Request body:', body)
        }
        
        const parsed = sendMessageBodySchema.safeParse(body)
        if (!parsed.success) {
            if (DEBUG) console.log('[DEBUG] Invalid body:', parsed.error)
            return c.json({ error: 'Invalid body' }, 400)
        }

        if (DEBUG) {
            console.log('[DEBUG] Calling engine.sendMessage:', {
                sessionId,
                text: parsed.data.text.substring(0, 100),
                localId: parsed.data.localId
            })
        }
        
        await engine.sendMessage(sessionId, { text: parsed.data.text, localId: parsed.data.localId, sentFrom: 'webapp' })
        
        if (DEBUG) {
            console.log('[DEBUG] Message sent successfully')
        }
        
        return c.json({ ok: true })
    })

    return app
}

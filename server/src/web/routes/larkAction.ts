import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { SyncEngine } from '../../sync/syncEngine'
import { createHmac, timingSafeEqual } from 'node:crypto'

const querySchema = z.object({
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    action: z.enum(['approve', 'deny']),
    ts: z.string().regex(/^[0-9]+$/),
    sig: z.string().min(1)
})

function sign(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

function safeEq(a: string, b: string): boolean {
    try {
        const ba = Buffer.from(a, 'utf8')
        const bb = Buffer.from(b, 'utf8')
        return ba.length === bb.length && timingSafeEqual(ba, bb)
    } catch {
        return false
    }
}

export function buildLarkActionUrl(params: {
    baseUrl: string
    sessionId: string
    requestId: string
    action: 'approve' | 'deny'
    ts: number
    secret: string
}): string {
    const payload = `${params.sessionId}.${params.requestId}.${params.action}.${params.ts}`
    const sig = sign(params.secret, payload)
    const url = new URL('/api/lark/permission', params.baseUrl)
    url.searchParams.set('sessionId', params.sessionId)
    url.searchParams.set('requestId', params.requestId)
    url.searchParams.set('action', params.action)
    url.searchParams.set('ts', String(params.ts))
    url.searchParams.set('sig', sig)
    return url.toString()
}

export function createLarkActionRoutes(options: {
    getSyncEngine: () => SyncEngine | null
    actionSecret: string
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // URL action endpoint (no JWT). Designed for cases where Lark webhook can't reach the server.
    app.get('/lark/permission', async (c) => {
        const parsed = querySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.text('Invalid request', 400)
        }

        const { sessionId, requestId, action, ts, sig } = parsed.data
        const now = Date.now()
        const tsNum = Number(ts)
        if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 10 * 60 * 1000) {
            return c.text('Expired request', 400)
        }

        const secret = options.actionSecret
        const payload = `${sessionId}.${requestId}.${action}.${tsNum}`
        const expected = sign(secret, payload)
        if (!safeEq(sig, expected)) {
            return c.text('Unauthorized', 401)
        }

        const engine = options.getSyncEngine()
        if (!engine) {
            return c.text('Not connected', 503)
        }

        const session = engine.getSession(sessionId)
        if (!session) {
            return c.text('Session not found', 404)
        }

        try {
            if (action === 'approve') {
                await engine.approvePermission(sessionId, requestId)
                return c.text('Approved')
            }
            await engine.denyPermission(sessionId, requestId)
            return c.text('Denied')
        } catch (e) {
            return c.text(e instanceof Error ? e.message : String(e), 500)
        }
    })

    return app
}

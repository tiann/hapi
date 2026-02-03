import { Hono } from 'hono'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import { randomBytes, randomUUID } from 'node:crypto'
import type { WebAppEnv } from '../middleware/auth'

const QR_SESSION_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface QrSession {
    id: string
    secret: string
    status: 'pending' | 'confirmed'
    createdAt: number
    // Set on confirm: the access token for the new terminal
    accessToken?: string
}

const qrSessions = new Map<string, QrSession>()

function cleanupExpired() {
    const now = Date.now()
    for (const [id, session] of qrSessions) {
        if (now - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
        }
    }
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string()
})

export function createQrRoutes(jwtSecret: Uint8Array, cliApiToken: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Create a new QR login session (no auth required)
    app.post('/qr', async (c) => {
        cleanupExpired()

        const id = randomUUID()
        const secret = randomBytes(24).toString('base64url')

        const session: QrSession = {
            id,
            secret,
            status: 'pending',
            createdAt: Date.now(),
        }
        qrSessions.set(id, session)

        return c.json({ id, secret })
    })

    // Poll QR login status (no auth required, needs secret)
    app.get('/qr/:id', async (c) => {
        cleanupExpired()

        const { id } = c.req.param()
        const secret = c.req.query('s')

        const session = qrSessions.get(id)
        if (!session) {
            return c.json({ status: 'expired' })
        }

        if (Date.now() - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
            return c.json({ status: 'expired' })
        }

        if (!secret || secret !== session.secret) {
            return c.json({ error: 'Invalid secret' }, 403)
        }

        if (session.status === 'confirmed' && session.accessToken) {
            // One-time: delete after delivering
            qrSessions.delete(id)
            c.header('Cache-Control', 'no-store')
            return c.json({
                status: 'confirmed',
                accessToken: session.accessToken,
            })
        }

        c.header('Cache-Control', 'no-store')
        return c.json({ status: 'pending' })
    })

    // Confirm QR login (requires auth - verified manually)
    app.post('/qr/:id/confirm', async (c) => {
        cleanupExpired()

        const { id } = c.req.param()
        const secret = c.req.query('s')

        // Manually verify JWT since this route is before auth middleware
        const authorization = c.req.header('authorization')
        const tokenStr = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        if (!tokenStr) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        let callerNamespace: string
        try {
            const verified = await jwtVerify(tokenStr, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token' }, 401)
            }
            callerNamespace = parsed.data.ns
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }

        const session = qrSessions.get(id)
        if (!session) {
            return c.json({ error: 'Session not found or expired' }, 404)
        }

        if (Date.now() - session.createdAt > QR_SESSION_TTL_MS) {
            qrSessions.delete(id)
            return c.json({ error: 'Session expired' }, 410)
        }

        if (!secret || secret !== session.secret) {
            return c.json({ error: 'Invalid secret' }, 403)
        }

        if (session.status !== 'pending') {
            return c.json({ error: 'Session already confirmed' }, 409)
        }

        // Build the access token with namespace for the new terminal
        const accessToken = callerNamespace === 'default'
            ? cliApiToken
            : `${cliApiToken}:${callerNamespace}`

        session.status = 'confirmed'
        session.accessToken = accessToken

        return c.json({ ok: true })
    })

    return app
}

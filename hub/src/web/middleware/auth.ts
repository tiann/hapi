import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
    }
}

// Exported for the voice WebSocket gate (bot review, tiann/hapi#2147,
// follow-up) — any token signed with the same jwtSecret and HS256
// verifies successfully regardless of *what* it's actually for (a
// passkey-session token, or the newer board-item recovery token, carry
// their own distinct claim shapes, no `uid`). That gate only ever
// checked signature + expiry, so a board recovery token — returned
// directly in a web API JSON response body on every partial create-card
// failure, far more casually exposed than a session credential — could
// pass it and reach a configured voice provider through the hub.
// Requiring this exact shape is what actually proves "this is a real
// web session," the same proof `createAuthMiddleware` below already
// requires for every other API route.
export const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string()
})

export function createAuthMiddleware(jwtSecret: Uint8Array): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (
            path === '/api/auth'
            || path === '/api/bind'
            || path === '/api/passkey/login/verify'
        ) {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        const tokenFromQuery = path === '/api/events' ? c.req.query().token : undefined
        const token = tokenFromHeader ?? tokenFromQuery

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token payload' }, 401)
            }

            c.set('userId', parsed.data.uid)
            c.set('namespace', parsed.data.ns)
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}

import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { verifyWebAuthToken } from '../authToken'
import type { CloudflareAccessVerifier } from '../cloudflareAccess'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
    }
}

export interface AuthMiddlewareOptions {
    /**
     * Cloudflare Access verifier override (tests only). When omitted, the
     * verifier for the configured bundle is used; an explicitly null value
     * models a disabled Cloudflare configuration.
     */
    cloudflareAccessVerifier?: CloudflareAccessVerifier | null
}

export function createAuthMiddleware(
    jwtSecret: Uint8Array,
    options: AuthMiddlewareOptions = {}
): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth' || path === '/api/bind') {
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

        const assertion = c.req.header('Cf-Access-Jwt-Assertion')
        const result = await verifyWebAuthToken(token, jwtSecret, assertion, {
            cloudflareAccessVerifier: options.cloudflareAccessVerifier
        })
        if (!result.ok) {
            return c.json({ error: result.error }, result.status)
        }

        c.set('userId', result.userId)
        c.set('namespace', result.namespace)
        await next()
        return
    }
}

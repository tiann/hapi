import { jwtVerify } from 'jose'
import { z } from 'zod'
import { getCloudflareAccessVerifier, type CloudflareAccessVerifier } from './cloudflareAccess'

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string(),
    authMethod: z.string().optional(),
    cfAccessSub: z.string().optional(),
    cfAccessEmail: z.string().optional()
})

export type WebAuthTokenVerification =
    | { ok: true; userId: number; namespace: string }
    | { ok: false; status: 401 | 403 | 503; error: string }

export interface VerifyWebAuthTokenOptions {
    /**
     * Cloudflare Access verifier override (tests only). When omitted, the
     * verifier for the configured bundle is used; an explicitly null value
     * models a disabled Cloudflare configuration.
     */
    cloudflareAccessVerifier?: CloudflareAccessVerifier | null
}

/**
 * Verify an HAPI web JWT for any consumer (REST, SSE, terminal, voice).
 *
 * Legacy JWTs (no authMethod) keep their existing uid/ns behaviour. JWTs
 * marked authMethod='cloudflareAccess' must additionally carry a current,
 * valid Cloudflare Access assertion whose subject, normalized email and
 * server-mapped namespace match the token; they are rejected outright when
 * the Cloudflare configuration is disabled.
 */
export async function verifyWebAuthToken(
    token: string,
    jwtSecret: Uint8Array,
    assertion: string | undefined,
    options: VerifyWebAuthTokenOptions = {}
): Promise<WebAuthTokenVerification> {
    let payload: z.infer<typeof jwtPayloadSchema>
    try {
        const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
        const parsed = jwtPayloadSchema.safeParse(verified.payload)
        if (!parsed.success) {
            return { ok: false, status: 401, error: 'Invalid token payload' }
        }
        payload = parsed.data
    } catch {
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    if (payload.authMethod === undefined) {
        return { ok: true, userId: payload.uid, namespace: payload.ns }
    }

    if (payload.authMethod !== 'cloudflareAccess') {
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    if (typeof payload.cfAccessSub !== 'string' || payload.cfAccessSub.length === 0
        || typeof payload.cfAccessEmail !== 'string' || payload.cfAccessEmail.length === 0) {
        return { ok: false, status: 401, error: 'Invalid token payload' }
    }

    const verifier = options.cloudflareAccessVerifier !== undefined
        ? options.cloudflareAccessVerifier
        : getCloudflareAccessVerifier()
    if (!verifier) {
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    if (!assertion) {
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    const verifiedAccess = await verifier.verify(assertion)
    if (verifiedAccess.kind !== 'ok') {
        if (verifiedAccess.kind === 'forbidden') {
            return { ok: false, status: 403, error: 'Access denied' }
        }
        if (verifiedAccess.kind === 'unavailable') {
            return { ok: false, status: 503, error: 'Authentication service unavailable' }
        }
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    if (verifiedAccess.subject !== payload.cfAccessSub
        || verifiedAccess.email !== payload.cfAccessEmail.toLowerCase()
        || verifiedAccess.namespace !== payload.ns) {
        return { ok: false, status: 401, error: 'Invalid token' }
    }

    return { ok: true, userId: payload.uid, namespace: payload.ns }
}

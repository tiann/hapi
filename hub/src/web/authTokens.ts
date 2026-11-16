import { createHmac } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'

const WEB_JWT_TTL = '4h'
export const PASSKEY_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const PASSKEY_SESSION_TYPE = 'passkey_session'

/** Short-lived bearer token accepted by the web API, SSE, and `/terminal`. */
export async function signWebJwt(jwtSecret: Uint8Array, userId: number, namespace: string): Promise<string> {
    return await new SignJWT({ uid: userId, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(WEB_JWT_TTL)
        .sign(jwtSecret)
}

/**
 * Long-lived refresh credential handed out after a passkey assertion. It has
 * no `uid` claim, so the web/terminal auth middleware never accepts it as a
 * bearer token; it can only be exchanged at `POST /api/auth`, which re-checks
 * that the backing passkey still exists and is still valid.
 */
export async function signPasskeySession(
    jwtSecret: Uint8Array,
    credentialId: string,
    namespace: string
): Promise<string> {
    return await new SignJWT({ typ: PASSKEY_SESSION_TYPE, cid: credentialId, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${PASSKEY_SESSION_TTL_SECONDS}s`)
        .sign(jwtSecret)
}

const passkeySessionSchema = z.object({
    typ: z.literal(PASSKEY_SESSION_TYPE),
    cid: z.string().min(1),
    ns: z.string()
})

export async function verifyPasskeySession(
    jwtSecret: Uint8Array,
    token: string
): Promise<{ credentialId: string; namespace: string } | null> {
    try {
        const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
        const parsed = passkeySessionSchema.safeParse(verified.payload)
        if (!parsed.success) return null
        return { credentialId: parsed.data.cid, namespace: parsed.data.ns }
    } catch {
        return null
    }
}

/**
 * Keyed fingerprint of the CLI access token. Passkeys record the fingerprint
 * current at registration; rotating `CLI_API_TOKEN` changes it and thereby
 * revokes every passkey (and passkey session) registered under the old token.
 */
export function cliTokenFingerprint(jwtSecret: Uint8Array, cliApiToken: string): string {
    return createHmac('sha256', jwtSecret)
        .update(`hapi-passkey-token:${cliApiToken}`)
        .digest('base64url')
}

/** Stable, hub-specific WebAuthn user handle for a namespace. */
export function passkeyUserHandle(jwtSecret: Uint8Array, namespace: string): Uint8Array<ArrayBuffer> {
    const digest = createHmac('sha256', jwtSecret)
        .update(`hapi-passkey-user:${namespace}`)
        .digest()
    return new Uint8Array(digest)
}

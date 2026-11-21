import { createHmac } from 'node:crypto'
import { encodePasskeyUserHandle, PASSKEY_ACCOUNT_TAG_BYTES } from '@hapi/protocol/passkey'
import { errors, SignJWT, jwtVerify } from 'jose'
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
export async function passkeyUserHandle(jwtSecret: Uint8Array, namespace: string, hub: string): Promise<Uint8Array<ArrayBuffer>> {
    const digest = createHmac('sha256', jwtSecret)
        .update(`hapi-passkey-user:${namespace}`)
        .digest()
    return encodePasskeyUserHandle(hub, digest.subarray(0, PASSKEY_ACCOUNT_TAG_BYTES))
}

const BOARD_ITEM_RECOVERY_TTL = '30m'
const BOARD_ITEM_RECOVERY_TYPE = 'board_item_recovery'

export type BoardItemRecoveryClaims = {
    boardId: string
    repo: string
    url: string
    assignees: string[]
}

/**
 * Proves a board-item create's partial-failure response (`createIssue`
 * succeeded, then assignee-application and/or project-attach failed) really
 * came from this hub, for *this* board/repo/issue/assignee-set — so a retry
 * can trust `url`/`assignees` without the client supplying them as free-form
 * request fields (review finding, tiann/hapi#2147, follow-up: an
 * owner-namespace request could otherwise point a retry at an arbitrary
 * issue in the right repo and have the hub edit its assignees or attach it
 * to the board, despite Boards never having created it — the regular
 * assignee-edit route verifies project membership first; this retry path
 * had nothing equivalent since the issue isn't on the project yet by
 * definition). 30-minute TTL: long enough to cover a user actually reading
 * the error and clicking retry, short enough that a leaked token (same
 * exposure as the URL it already carries) doesn't stay exploitable long.
 */
export async function signBoardItemRecoveryToken(jwtSecret: Uint8Array, claims: BoardItemRecoveryClaims): Promise<string> {
    return await new SignJWT({ typ: BOARD_ITEM_RECOVERY_TYPE, ...claims })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(BOARD_ITEM_RECOVERY_TTL)
        .sign(jwtSecret)
}

const boardItemRecoverySchema = z.object({
    typ: z.literal(BOARD_ITEM_RECOVERY_TYPE),
    boardId: z.string(),
    repo: z.string(),
    url: z.string(),
    assignees: z.array(z.string())
})

export type BoardItemRecoveryVerification =
    | { ok: true; claims: BoardItemRecoveryClaims }
    // `expired` distinguishes "this really was a legitimate retry token,
    // it just aged out" from "forged, malformed, or for a different
    // board/typ entirely" (bot review, tiann/hapi#2147, follow-up) — the
    // dialog needs this distinction to offer a different recovery path
    // (keep the already-created issue's link visible, stop offering a
    // retry that would just 400 forever) than a flatly invalid token,
    // which has no legitimate prior state to point back to at all.
    | { ok: false; expired: boolean }

export async function verifyBoardItemRecoveryToken(jwtSecret: Uint8Array, token: string): Promise<BoardItemRecoveryVerification> {
    try {
        const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
        const parsed = boardItemRecoverySchema.safeParse(verified.payload)
        if (!parsed.success) return { ok: false, expired: false }
        return { ok: true, claims: { boardId: parsed.data.boardId, repo: parsed.data.repo, url: parsed.data.url, assignees: parsed.data.assignees } }
    } catch (error) {
        return { ok: false, expired: error instanceof errors.JWTExpired }
    }
}

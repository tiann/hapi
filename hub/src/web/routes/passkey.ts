import { Hono } from 'hono'
import type { Context } from 'hono'
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers'
import {
    PasskeyLoginVerifyRequestSchema,
    PasskeyRegisterVerifyRequestSchema,
    type PasskeyListResponse
} from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { constantTimeEquals } from '../../utils/crypto'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import {
    cliTokenFingerprint,
    passkeyUserHandle,
    signPasskeySession,
    signWebJwt
} from '../authTokens'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_CHALLENGES = 256
const RP_NAME = 'HAPI'

type ChallengeEntry =
    | { kind: 'register'; rpId: string; origin: string; namespace: string; expiresAt: number }
    | { kind: 'login'; rpId: string; origin: string; expiresAt: number }

/**
 * One-time WebAuthn challenges. Entries are removed on first lookup, so a
 * replayed assertion fails even if it is otherwise valid.
 */
export class PasskeyChallengeStore {
    private readonly entries = new Map<string, ChallengeEntry>()

    constructor(private readonly now: () => number = Date.now) {}

    /**
     * Bounded: when full, the oldest pending challenge is evicted rather than
     * rejecting new ones, so unauthenticated option requests cannot lock
     * legitimate users out for the whole TTL.
     */
    put(challenge: string, entry: ChallengeEntry): void {
        this.prune()
        while (this.entries.size >= MAX_PENDING_CHALLENGES) {
            const oldest = this.entries.keys().next().value
            if (oldest === undefined) break
            this.entries.delete(oldest)
        }
        this.entries.set(challenge, entry)
    }

    take(challenge: string): ChallengeEntry | null {
        const entry = this.entries.get(challenge)
        if (!entry) return null
        this.entries.delete(challenge)
        return entry.expiresAt > this.now() ? entry : null
    }

    private prune(): void {
        const now = this.now()
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key)
        }
    }
}

function isIpHostname(hostname: string): boolean {
    return /^[\d.]+$/.test(hostname) || hostname.includes(':') || hostname.startsWith('[')
}

/**
 * Resolve the WebAuthn relying party from the browser's Origin header.
 *
 * The origin must be trusted (same host as the request, i.e. the hub-served
 * web app, or an explicitly configured CORS origin) and a secure context with
 * a domain name: WebAuthn rejects IP-address RP IDs and plain HTTP except on
 * `localhost`.
 */
export function resolveRelyingParty(
    originHeader: string | undefined,
    hostHeader: string | undefined,
    corsOrigins: string[]
): { origin: string; rpId: string } | { error: string } {
    if (!originHeader) {
        return { error: 'Missing Origin header' }
    }
    let url: URL
    try {
        url = new URL(originHeader)
    } catch {
        return { error: 'Invalid Origin header' }
    }
    const origin = url.origin
    const hostname = url.hostname.toLowerCase()
    const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
        return { error: 'Passkeys require HTTPS (or localhost)' }
    }
    if (isIpHostname(hostname)) {
        return { error: 'Passkeys require a domain name, not an IP address' }
    }

    const sameHost = hostHeader !== undefined && url.host.toLowerCase() === hostHeader.toLowerCase()
    const listed = corsOrigins.some((allowed) => allowed !== '*' && allowed === origin)
    if (!sameHost && !listed) {
        return { error: 'Origin is not allowed to use passkeys' }
    }
    return { origin, rpId: hostname }
}

function relyingPartyFor(c: Context, corsOrigins: () => string[]) {
    return resolveRelyingParty(c.req.header('origin'), c.req.header('host'), corsOrigins())
}

function currentFingerprint(jwtSecret: Uint8Array): string {
    return cliTokenFingerprint(jwtSecret, getConfiguration().cliApiToken)
}

function challengeOf(clientDataJSON: string): string | null {
    try {
        return decodeClientDataJSON(clientDataJSON).challenge
    } catch {
        return null
    }
}

export type PasskeyRouteDeps = {
    jwtSecret: Uint8Array
    store: Store
    corsOrigins: () => string[]
    challenges: PasskeyChallengeStore
}

/** Unauthenticated: exchange a passkey assertion for a web JWT + passkey session. */
export function createPasskeyLoginRoutes(deps: PasskeyRouteDeps): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const { jwtSecret, store, challenges } = deps

    app.post('/passkey/login/options', async (c) => {
        const rp = relyingPartyFor(c, deps.corsOrigins)
        if ('error' in rp) {
            return c.json({ error: rp.error }, 400)
        }
        const options = await generateAuthenticationOptions({
            rpID: rp.rpId,
            userVerification: 'required'
        })
        challenges.put(options.challenge, {
            kind: 'login',
            rpId: rp.rpId,
            origin: rp.origin,
            expiresAt: Date.now() + CHALLENGE_TTL_MS
        })
        return c.json(options)
    })

    app.post('/passkey/login/verify', async (c) => {
        const parsed = PasskeyLoginVerifyRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const response = parsed.data.response as unknown as AuthenticationResponseJSON
        const challenge = challengeOf(response.response.clientDataJSON)
        const entry = challenge ? challenges.take(challenge) : null
        if (!challenge || !entry || entry.kind !== 'login') {
            return c.json({ error: 'Passkey challenge expired' }, 401)
        }

        const credential = store.passkeys.get(response.id)
        if (!credential || credential.rpId !== entry.rpId) {
            return c.json({ error: 'Unknown passkey' }, 401)
        }
        if (!constantTimeEquals(credential.tokenFingerprint, currentFingerprint(jwtSecret))) {
            return c.json({ error: 'passkey_revoked' }, 401)
        }

        let newCounter: number
        try {
            const verification = await verifyAuthenticationResponse({
                response,
                expectedChallenge: challenge,
                expectedOrigin: entry.origin,
                expectedRPID: entry.rpId,
                credential: {
                    id: credential.id,
                    publicKey: credential.publicKey,
                    counter: credential.counter,
                    transports: credential.transports
                },
                requireUserVerification: true
            })
            if (!verification.verified) {
                return c.json({ error: 'Passkey verification failed' }, 401)
            }
            newCounter = verification.authenticationInfo.newCounter
        } catch {
            return c.json({ error: 'Passkey verification failed' }, 401)
        }

        store.passkeys.recordUse(credential.id, newCounter, Date.now())
        const userId = await getOrCreateOwnerId()
        return c.json({
            token: await signWebJwt(jwtSecret, userId, credential.namespace),
            passkeySession: await signPasskeySession(jwtSecret, credential.id, credential.namespace),
            user: { id: userId, firstName: 'Web User' }
        })
    })

    return app
}

/** Authenticated: register, list, and delete passkeys for the caller's namespace. */
export function createPasskeyManagementRoutes(deps: PasskeyRouteDeps): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const { jwtSecret, store, challenges } = deps

    app.post('/passkey/register/options', async (c) => {
        const rp = relyingPartyFor(c, deps.corsOrigins)
        if ('error' in rp) {
            return c.json({ error: rp.error }, 400)
        }
        const namespace = c.get('namespace')
        const existing = store.passkeys.listByNamespace(namespace).filter((p) => p.rpId === rp.rpId)
        const options = await generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: rp.rpId,
            userID: passkeyUserHandle(jwtSecret, namespace),
            userName: namespace === 'default' ? 'hapi' : `hapi:${namespace}`,
            userDisplayName: namespace === 'default' ? 'HAPI' : `HAPI (${namespace})`,
            attestationType: 'none',
            excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required'
            }
        })
        challenges.put(options.challenge, {
            kind: 'register',
            rpId: rp.rpId,
            origin: rp.origin,
            namespace,
            expiresAt: Date.now() + CHALLENGE_TTL_MS
        })
        return c.json(options)
    })

    app.post('/passkey/register/verify', async (c) => {
        const parsed = PasskeyRegisterVerifyRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const namespace = c.get('namespace')
        const response = parsed.data.response as unknown as RegistrationResponseJSON
        const challenge = challengeOf(response.response.clientDataJSON)
        const entry = challenge ? challenges.take(challenge) : null
        if (!challenge || !entry || entry.kind !== 'register' || entry.namespace !== namespace) {
            return c.json({ error: 'Passkey challenge expired' }, 400)
        }

        let registered: { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports: string[] }
        try {
            const verification = await verifyRegistrationResponse({
                response,
                expectedChallenge: challenge,
                expectedOrigin: entry.origin,
                expectedRPID: entry.rpId,
                requireUserVerification: true
            })
            if (!verification.verified) {
                return c.json({ error: 'Passkey verification failed' }, 400)
            }
            const credential = verification.registrationInfo.credential
            registered = {
                id: credential.id,
                publicKey: credential.publicKey,
                counter: credential.counter,
                transports: credential.transports ?? []
            }
        } catch {
            return c.json({ error: 'Passkey verification failed' }, 400)
        }

        if (store.passkeys.get(registered.id)) {
            return c.json({ error: 'Passkey already registered' }, 409)
        }
        store.passkeys.add({
            ...registered,
            namespace,
            rpId: entry.rpId,
            tokenFingerprint: currentFingerprint(jwtSecret),
            name: parsed.data.name || null,
            createdAt: Date.now()
        })
        return c.json({ ok: true, id: registered.id })
    })

    app.get('/passkeys', (c) => {
        const fingerprint = currentFingerprint(jwtSecret)
        const body: PasskeyListResponse = {
            passkeys: store.passkeys.listByNamespace(c.get('namespace')).map((p) => ({
                id: p.id,
                name: p.name,
                rpId: p.rpId,
                createdAt: p.createdAt,
                lastUsedAt: p.lastUsedAt,
                valid: constantTimeEquals(p.tokenFingerprint, fingerprint)
            }))
        }
        return c.json(body)
    })

    app.delete('/passkeys/:id', (c) => {
        const removed = store.passkeys.remove(c.req.param('id'), c.get('namespace'))
        if (!removed) {
            return c.json({ error: 'Passkey not found' }, 404)
        }
        return c.json({ ok: true })
    })

    return app
}

import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import {
    PasskeyBrowserExchangeRequestSchema,
    PasskeyBrowserStartRequestSchema,
    PasskeyLoginVerifyRequestSchema,
    PasskeyOptionsRequestSchema,
    PasskeyRegisterVerifyRequestSchema,
    type PasskeyBrowserStartRequest,
    type PasskeyListResponse
} from '@hapi/protocol'
import {
    canonicalPasskeyHub, encodePasskeyChallenge, PASSKEY_CALLBACK_PATH,
    PASSKEY_MAX_REQUEST_LENGTH, PASSKEY_ORIGIN, PASSKEY_RP_ID,
    type PasskeyChannel, type PasskeyOperation
} from '@hapi/protocol/passkey'
import { getConfiguration } from '../../configuration'
import { getOrCreateOwnerId } from '../../config/ownerId'
import { constantTimeEquals } from '../../utils/crypto'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { cliTokenFingerprint, passkeyUserHandle, signPasskeySession, signWebJwt } from '../authTokens'

await import('reflect-metadata')
const { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse }
    = await import('@simplewebauthn/server')
const { decodeClientDataJSON } = await import('@simplewebauthn/server/helpers')

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const CODE_TTL_MS = 60 * 1000
const random = () => randomBytes(32).toString('base64url')
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url')

type BrowserBinding = PasskeyBrowserStartRequest

type ChallengeEntry = {
    kind: PasskeyOperation
    channel: PasskeyChannel
    rpId: string
    origins: string[]
    hub: string
    namespace?: string
    fingerprint: string
    expiresAt: number
    browser?: BrowserBinding
}

type CodeEntry = {
    operation: PasskeyOperation
    credentialId: string
    namespace: string
    fingerprint: string
    codeChallenge: string
    expiresAt: number
}

/** Bounded, expiring state. A code is consumed only after PKCE is checked. */
class OneTimeStore<T extends { expiresAt: number }> {
    private readonly entries = new Map<string, T>()
    constructor(private readonly now: () => number = Date.now) {}
    put(key: string, entry: T): void {
        for (const [id, value] of this.entries) if (value.expiresAt <= this.now()) this.entries.delete(id)
        while (this.entries.size >= 256) this.entries.delete(this.entries.keys().next().value!)
        this.entries.set(key, entry)
    }
    get(key: string): T | null {
        const entry = this.entries.get(key)
        if (!entry || entry.expiresAt <= this.now()) {
            this.entries.delete(key)
            return null
        }
        return entry
    }
    take(key: string): T | null {
        const entry = this.get(key)
        this.entries.delete(key)
        return entry
    }
}

export class PasskeyChallengeStore extends OneTimeStore<ChallengeEntry> {
    readonly codes: OneTimeStore<CodeEntry>
    constructor(now: () => number = Date.now) {
        super(now)
        this.codes = new OneTimeStore(now)
    }
}

export type NativePasskeyConfig = { rpId: string; origins: string[] }
export const OFFICIAL_ANDROID_PASSKEY_ORIGINS = [
    'android:apk-key-hash:gPW441aKA2v53lho7kg86hFe1WjiLKXKUy4Iz3Kvfs8'
]

/** Forks must change the shared RP and app associations together. Extra origins
 * are only for explicitly trusted Android signing certificates (e.g. debug). */
export function nativePasskeyConfigFromEnv(env: Record<string, string | undefined> = process.env): NativePasskeyConfig {
    const extra = (env.HAPI_PASSKEY_NATIVE_ORIGINS ?? '').split(',').map((v) => v.trim()).filter(Boolean)
    if (extra.some((origin) => !/^android:apk-key-hash:[A-Za-z0-9_-]+$/.test(origin))) {
        throw new Error('HAPI_PASSKEY_NATIVE_ORIGINS only accepts Android signing-certificate origins')
    }
    return { rpId: PASSKEY_RP_ID, origins: [...new Set([PASSKEY_ORIGIN, ...OFFICIAL_ANDROID_PASSKEY_ORIGINS, ...extra])] }
}

export type PasskeyRouteDeps = {
    jwtSecret: Uint8Array
    store: Store
    corsOrigins: () => string[]
    hubUrl: () => string
    challenges: PasskeyChallengeStore
    native: NativePasskeyConfig
}

function fingerprint(deps: PasskeyRouteDeps): string {
    return cliTokenFingerprint(deps.jwtSecret, getConfiguration().cliApiToken)
}

function hubOrigin(deps: PasskeyRouteDeps): string {
    try { return canonicalPasskeyHub(deps.hubUrl()) } catch {
        throw new Error('Configure HAPI_PUBLIC_URL as the canonical HTTPS Hub origin to use passkeys')
    }
}

async function optionsFor(
    deps: PasskeyRouteDeps, kind: PasskeyOperation, channel: PasskeyChannel,
    namespace?: string, browser?: BrowserBinding
) {
    const hub = hubOrigin(deps)
    const entry: ChallengeEntry = {
        kind, channel, hub, namespace, browser, fingerprint: fingerprint(deps), rpId: PASSKEY_RP_ID,
        origins: channel === 'browser' ? [PASSKEY_ORIGIN] : deps.native.origins,
        expiresAt: Date.now() + CHALLENGE_TTL_MS
    }
    const challenge = encodePasskeyChallenge({ v: 1, hub, operation: kind, channel, id: random(), nonce: random() })
    if (kind === 'login') {
        const allowCredentials = deps.store.passkeys.listByRpId(PASSKEY_RP_ID)
            .filter((p) => constantTimeEquals(p.tokenFingerprint, entry.fingerprint))
            .map((p) => ({ id: p.id, transports: p.transports }))
        if (allowCredentials.length === 0) throw new Error('no_passkeys')
        const options = await generateAuthenticationOptions({ rpID: PASSKEY_RP_ID, challenge: Buffer.from(challenge, 'base64url'), allowCredentials, userVerification: 'required' })
        deps.challenges.put(challenge, entry)
        return options
    }
    const ns = namespace!
    const existing = deps.store.passkeys.listByNamespace(ns).filter((p) => p.rpId === PASSKEY_RP_ID)
    const account = ns === 'default' ? 'hapi' : `hapi:${ns}`
    const options = await generateRegistrationOptions({
        rpName: 'HAPI', rpID: PASSKEY_RP_ID, challenge: Buffer.from(challenge, 'base64url'),
        userID: passkeyUserHandle(deps.jwtSecret, ns, hub),
        userName: `${account}@${new URL(hub).host}`,
        userDisplayName: `HAPI · ${new URL(hub).host}${ns === 'default' ? '' : ` (${ns})`}`,
        attestationType: 'none',
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
    })
    deps.challenges.put(challenge, entry)
    return options
}

function entryFor(deps: PasskeyRouteDeps, clientData: string, channel: PasskeyChannel, kind?: PasskeyOperation) {
    const challenge = decodeClientDataJSON(clientData).challenge
    const entry = deps.challenges.take(challenge)
    if (!entry || entry.channel !== channel || (kind && entry.kind !== kind)) throw new Error('Passkey challenge expired')
    assertCurrent(deps, entry)
    return { entry, challenge }
}

function assertCurrent(deps: PasskeyRouteDeps, entry: { fingerprint: string; expiresAt: number }) {
    if (entry.expiresAt <= Date.now()) throw new Error('Passkey challenge expired')
    if (!constantTimeEquals(entry.fingerprint, fingerprint(deps))) throw new Error('passkey_revoked')
}

async function authenticate(deps: PasskeyRouteDeps, entry: ChallengeEntry, challenge: string, response: AuthenticationResponseJSON) {
    const credential = deps.store.passkeys.get(response.id)
    if (!credential || credential.rpId !== entry.rpId) throw new Error('Unknown passkey')
    if (!constantTimeEquals(credential.tokenFingerprint, entry.fingerprint)) throw new Error('passkey_revoked')
    const result = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge, expectedOrigin: entry.origins, expectedRPID: entry.rpId,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports },
        requireUserVerification: true
    })
    if (!result.verified) throw new Error('Passkey verification failed')
    assertCurrent(deps, entry)
    // Deletion while an asynchronous verification is in flight must not revive it.
    const current = deps.store.passkeys.get(credential.id)
    if (!current) throw new Error('Unknown passkey')
    if (result.authenticationInfo.newCounter !== 0 && current.counter >= result.authenticationInfo.newCounter) {
        throw new Error('Passkey verification failed')
    }
    deps.store.passkeys.recordUse(credential.id, result.authenticationInfo.newCounter, Date.now())
    return { credentialId: credential.id, namespace: credential.namespace }
}

async function register(deps: PasskeyRouteDeps, entry: ChallengeEntry, challenge: string, response: RegistrationResponseJSON, name?: string) {
    const result = await verifyRegistrationResponse({
        response, expectedChallenge: challenge, expectedOrigin: entry.origins, expectedRPID: entry.rpId, requireUserVerification: true
    })
    if (!result.verified) throw new Error('Passkey verification failed')
    assertCurrent(deps, entry)
    const credential = result.registrationInfo.credential
    if (deps.store.passkeys.get(credential.id)) throw new Error('Passkey already registered')
    deps.store.passkeys.add({
        id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [],
        namespace: entry.namespace!, rpId: entry.rpId, tokenFingerprint: entry.fingerprint,
        name: name || null, createdAt: Date.now()
    })
    return { credentialId: credential.id, namespace: entry.namespace! }
}

async function session(deps: PasskeyRouteDeps, id: string, namespace: string) {
    const userId = await getOrCreateOwnerId()
    return {
        token: await signWebJwt(deps.jwtSecret, userId, namespace),
        passkeySession: await signPasskeySession(deps.jwtSecret, id, namespace),
        user: { id: userId, firstName: 'Web User' }
    }
}

function message(error: unknown): string {
    const text = error instanceof Error ? error.message : ''
    return ['cancelled', 'no_passkeys', 'passkey_revoked', 'Unknown passkey', 'Passkey challenge expired', 'Passkey already registered'].includes(text)
        || text.startsWith('Configure HAPI_PUBLIC_URL') ? text : 'Passkey verification failed'
}

const limitedRequests = new WeakSet<object>()

function secureRoutes() {
    const app = new Hono<WebAppEnv>()
    app.use('/passkey/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        c.header('Referrer-Policy', 'no-referrer')
        c.header('X-Content-Type-Options', 'nosniff')
        // Route groups share middleware paths. Cache a bounded body once,
        // before route-level parse error handling, including chunked requests.
        if (c.req.raw.body && !limitedRequests.has(c.req)) {
            const reader = c.req.raw.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                size += value.byteLength
                if (size > 128 * 1024) {
                    await reader.cancel()
                    return c.json({ error: 'Payload too large' }, 413)
                }
                chunks.push(value)
            }
            const bytes = new Uint8Array(size)
            let offset = 0
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
            c.req.raw = new Request(c.req.raw, { body: bytes })
            limitedRequests.add(c.req)
        }
        return next()
    })
    return app
}

async function browserStart(c: Context<WebAppEnv>, deps: PasskeyRouteDeps, operation: PasskeyOperation) {
    const parsed = PasskeyBrowserStartRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
    const b = parsed.data
    try {
        const origin = canonicalPasskeyHub(b.callbackOrigin)
        if (origin !== b.callbackOrigin || c.req.header('origin') !== origin
            || (origin !== hubOrigin(deps) && !deps.corsOrigins().some((o) => o !== '*' && o === origin))) {
            return c.json({ error: 'Passkey callback origin is not allowed' }, 400)
        }
        const options = await optionsFor(deps, operation, 'browser', operation === 'register' ? c.get('namespace') : undefined, b)
        const request = JSON.stringify({ hub: hubOrigin(deps), operation, options })
        if (request.length > PASSKEY_MAX_REQUEST_LENGTH) return c.json({ error: 'Too many passkeys for browser sign-in' }, 400)
        return c.json({ url: `${PASSKEY_ORIGIN}/#${encodeURIComponent(request)}` })
    } catch (error) { return c.json({ error: message(error) }, message(error) === 'no_passkeys' ? 404 : 400) }
}

export function createPasskeyLoginRoutes(deps: PasskeyRouteDeps): Hono<WebAppEnv> {
    const app = secureRoutes()
    app.post('/passkey/login/options', async (c) => {
        if (!PasskeyOptionsRequestSchema.safeParse(await c.req.json().catch(() => null)).success) return c.json({ error: 'Native client required' }, 400)
        try { return c.json(await optionsFor(deps, 'login', 'native')) }
        catch (error) { return c.json({ error: message(error) }, message(error) === 'no_passkeys' ? 404 : 400) }
    })
    app.post('/passkey/login/verify', async (c) => {
        const parsed = PasskeyLoginVerifyRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const response = parsed.data.response as unknown as AuthenticationResponseJSON
            const { entry, challenge } = entryFor(deps, response.response.clientDataJSON, 'native', 'login')
            const result = await authenticate(deps, entry, challenge, response)
            return c.json(await session(deps, result.credentialId, result.namespace))
        } catch (error) { return c.json({ error: message(error) }, 401) }
    })
    app.post('/passkey/browser/login/start', (c) => browserStart(c, deps, 'login'))
    app.post('/passkey/browser/complete', async (c) => {
        if (c.req.header('origin') !== PASSKEY_ORIGIN || !c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) {
            return c.json({ error: 'Invalid ceremony origin or content type' }, 400)
        }
        // A native challenge can never be exchanged through the browser bridge.
        let entry: ChallengeEntry
        let challenge: string
        try {
            const form = Object.fromEntries(new URLSearchParams(await c.req.text()))
            if (typeof form.challenge !== 'string') throw new Error('Invalid body')
            challenge = form.challenge
            const found = deps.challenges.take(challenge)
            if (!found || found.channel !== 'browser' || !found.browser) throw new Error('Passkey challenge expired')
            entry = found
        } catch (error) { return c.json({ error: message(error) }, 401) }
        const callback = new URL(PASSKEY_CALLBACK_PATH, entry.browser!.callbackOrigin)
        const fragment = new URLSearchParams({ state: entry.browser!.state })
        try {
            assertCurrent(deps, entry)
            const form = Object.fromEntries(new URLSearchParams(await c.req.text()))
            if (form.error === 'cancelled') throw new Error('cancelled')
            const parsed = PasskeyLoginVerifyRequestSchema.safeParse({ response: typeof form.response === 'string' ? JSON.parse(form.response) : null })
            if (!parsed.success) throw new Error('Invalid body')
            if (decodeClientDataJSON(parsed.data.response.response.clientDataJSON).challenge !== challenge) throw new Error('Invalid challenge')
            const result = entry.kind === 'login'
                ? await authenticate(deps, entry, challenge, parsed.data.response as unknown as AuthenticationResponseJSON)
                : await register(deps, entry, challenge, parsed.data.response as unknown as RegistrationResponseJSON, entry.browser!.name)
            const code = random()
            deps.challenges.codes.put(code, {
                ...result, operation: entry.kind, fingerprint: entry.fingerprint,
                codeChallenge: entry.browser!.codeChallenge, expiresAt: Date.now() + CODE_TTL_MS
            })
            fragment.set('code', code)
        } catch (error) { fragment.set('error', message(error)) }
        callback.hash = fragment.toString()
        return c.redirect(callback.href, 303)
    })
    app.post('/passkey/browser/exchange', async (c) => {
        const parsed = PasskeyBrowserExchangeRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const { code, verifier } = parsed.data
        const entry = deps.challenges.codes.get(code)
        if (!entry || !constantTimeEquals(sha256(verifier), entry.codeChallenge)) return c.json({ error: 'Invalid authorization code' }, 401)
        deps.challenges.codes.take(code)
        const credential = deps.store.passkeys.get(entry.credentialId)
        if (!credential || credential.namespace !== entry.namespace || !constantTimeEquals(credential.tokenFingerprint, fingerprint(deps))
            || !constantTimeEquals(entry.fingerprint, fingerprint(deps))) return c.json({ error: 'passkey_revoked' }, 401)
        if (entry.operation === 'register') return c.json({ operation: 'register' as const })
        return c.json({ operation: 'login' as const, ...await session(deps, entry.credentialId, entry.namespace) })
    })
    return app
}

export function createPasskeyManagementRoutes(deps: PasskeyRouteDeps): Hono<WebAppEnv> {
    const app = secureRoutes()
    app.post('/passkey/browser/register/start', (c) => browserStart(c, deps, 'register'))
    app.post('/passkey/register/options', async (c) => {
        if (!PasskeyOptionsRequestSchema.safeParse(await c.req.json().catch(() => null)).success) return c.json({ error: 'Native client required' }, 400)
        try { return c.json(await optionsFor(deps, 'register', 'native', c.get('namespace'))) }
        catch (error) { return c.json({ error: message(error) }, 400) }
    })
    app.post('/passkey/register/verify', async (c) => {
        const parsed = PasskeyRegisterVerifyRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        try {
            const response = parsed.data.response as unknown as RegistrationResponseJSON
            const { entry, challenge } = entryFor(deps, response.response.clientDataJSON, 'native', 'register')
            if (entry.namespace !== c.get('namespace')) throw new Error('Invalid namespace')
            const result = await register(deps, entry, challenge, response, parsed.data.name)
            return c.json({ ok: true, id: result.credentialId })
        } catch (error) { return c.json({ error: message(error) }, message(error) === 'Passkey already registered' ? 409 : 400) }
    })
    app.get('/passkeys', (c) => {
        const body: PasskeyListResponse = {
            passkeys: deps.store.passkeys.listByNamespace(c.get('namespace')).map((p) => ({
                id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
                valid: p.rpId === PASSKEY_RP_ID && constantTimeEquals(p.tokenFingerprint, fingerprint(deps))
            }))
        }
        return c.json(body)
    })
    app.delete('/passkeys/:id', (c) => {
        if (!deps.store.passkeys.remove(c.req.param('id'), c.get('namespace'))) return c.json({ error: 'Passkey not found' }, 404)
        return c.json({ ok: true })
    })
    return app
}

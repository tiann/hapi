import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createConfiguration } from '../configuration'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from './cloudflareAccess'
import { authorizeVoiceWebSocketRequest, startWebServer } from './server'
import type { Store } from '../store'

const JWT_SECRET = new TextEncoder().encode('test-secret')

const CF_CONFIG: CloudflareAccessConfig = {
    teamDomain: 'synthetic.cloudflareaccess.com',
    audience: 'synthetic-audience',
    users: { 'alice@example.com': 'default' }
}

const ISSUER = 'https://synthetic.cloudflareaccess.com'

let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey }
let jwks: { keys: Array<Record<string, string>> }

async function initKeys() {
    if (keyPair) return
    keyPair = await generateKeyPair('RS256')
    jwks = { keys: [await exportJWK(keyPair.publicKey) as unknown as Record<string, string>] }
}

async function localVerifier(): Promise<CloudflareAccessVerifier> {
    await initKeys()
    return createCloudflareAccessVerifier(CF_CONFIG, { keyResolver: createLocalJWKSet(jwks) })
}

async function signAccessAssertion(claims: Record<string, unknown> = {}): Promise<string> {
    return await new SignJWT({ sub: 'subject-1', email: 'alice@example.com', ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(CF_CONFIG.audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keyPair.privateKey)
}

async function signHapiToken(payload: Record<string, unknown>): Promise<string> {
    return await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
}

function voiceRequest(token: string | null, assertion?: string): Request {
    const url = `http://hub.test/api/voice/gemini-ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const headers: Record<string, string> = {}
    if (assertion) headers['Cf-Access-Jwt-Assertion'] = assertion
    return new Request(url, { headers })
}

describe('authorizeVoiceWebSocketRequest', () => {
    test('rejects a missing token', async () => {
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(null), JWT_SECRET)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('accepts a legacy JWT', async () => {
        const token = await signHapiToken({ uid: 7, ns: 'default' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token), JWT_SECRET)
        expect(result).toEqual({ ok: true })
    })

    test('rejects a marked JWT when Cloudflare is disabled', async () => {
        await initKeys()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 8, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, assertion), JWT_SECRET, { cloudflareAccessVerifier: null })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a marked JWT without a current assertion', async () => {
        const token = await signHapiToken({ uid: 9, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token), JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a marked JWT with an invalid assertion', async () => {
        const token = await signHapiToken({ uid: 10, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, 'garbage'), JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a marked JWT whose email is not allowlisted', async () => {
        const assertion = await signAccessAssertion({ email: 'mallory@example.com' })
        const token = await signHapiToken({ uid: 11, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'mallory@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, assertion), JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(403)
    })

    test('returns 503 when the key service is unavailable', async () => {
        const assertion = await signAccessAssertion()
        const unavailable = createCloudflareAccessVerifier(CF_CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const token = await signHapiToken({ uid: 12, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, assertion), JWT_SECRET, { cloudflareAccessVerifier: unavailable })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(503)
    })

    test('rejects an assertion whose subject doesn\'t match the JWT', async () => {
        const assertion = await signAccessAssertion({ sub: 'subject-other' })
        const token = await signHapiToken({ uid: 13, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, assertion), JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('accepts a marked JWT with a matching current assertion', async () => {
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 14, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await authorizeVoiceWebSocketRequest(voiceRequest(token, assertion), JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result).toEqual({ ok: true })
    })
})

describe('voice WebSocket upgrade gates (live server)', () => {
    let server: { port: number; stop: (force?: boolean) => void } | null = null
    let baseUrl = ''

    beforeAll(async () => {
        await createConfiguration()
        const webServer = await startWebServer({
            getSyncEngine: () => null,
            getSseManager: () => null,
            getVisibilityTracker: () => null,
            jwtSecret: JWT_SECRET,
            store: {} as Store,
            vapidPublicKey: 'test-vapid-key',
            socketEngine: {
                handler: () => ({
                    websocket: {},
                    fetch: () => new Response('not found', { status: 404 }),
                    idleTimeout: 60,
                    maxHttpBufferSize: 1_000_000
                })
            } as never
        })
        server = webServer as unknown as { port: number; stop: (force?: boolean) => void }
        baseUrl = `http://127.0.0.1:${server.port}`
    })

    afterAll(() => {
        server?.stop(true)
        server = null
    })

    test('rejects a missing token before any upgrade', async () => {
        const res = await fetch(`${baseUrl}/api/voice/gemini-ws`)
        expect(res.status).toBe(401)
        expect(await res.text()).toBe('Missing authorization token')
    })

    test('rejects an invalid token', async () => {
        const res = await fetch(`${baseUrl}/api/voice/gemini-ws?token=garbage`)
        expect(res.status).toBe(401)
    })

    test('accepts a legacy JWT and proceeds to the API-key gate', async () => {
        const token = await signHapiToken({ uid: 20, ns: 'default' })
        const res = await fetch(`${baseUrl}/api/voice/gemini-ws?token=${encodeURIComponent(token)}`)
        expect(res.status).toBe(400)
        expect(await res.text()).toBe('Gemini API key not configured')
    })

    test('a Cloudflare-derived HAPI JWT alone cannot open the voice WebSocket', async () => {
        const token = await signHapiToken({ uid: 21, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await fetch(`${baseUrl}/api/voice/gemini-ws?token=${encodeURIComponent(token)}`)
        expect(res.status).toBe(401)
        expect(await res.text()).toBe('Invalid token')
    })

    test('a marked JWT with a forwarded assertion is still rejected while Cloudflare is disabled', async () => {
        const token = await signHapiToken({ uid: 22, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await fetch(`${baseUrl}/api/voice/gemini-ws?token=${encodeURIComponent(token)}`, {
            headers: { 'Cf-Access-Jwt-Assertion': 'present-but-irrelevant' }
        })
        expect(res.status).toBe(401)
    })
})

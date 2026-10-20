import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CloudflareAccessConfig } from '../../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from '../cloudflareAccess'
import { createAuthMiddleware, type WebAppEnv } from './auth'

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

function createApp(options: { cloudflareAccessVerifier?: CloudflareAccessVerifier | null } = {}) {
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(JWT_SECRET, options))
    app.get('/api/sessions', (c) => c.json({ userId: c.get('userId'), namespace: c.get('namespace') }))
    app.get('/api/events', (c) => c.json({ userId: c.get('userId'), namespace: c.get('namespace') }))
    app.post('/api/auth', (c) => c.json({ ok: true }))
    app.post('/api/bind', (c) => c.json({ ok: true }))
    return app
}

describe('createAuthMiddleware', () => {
    test('rejects a missing token', async () => {
        const res = await createApp().request('/api/sessions')
        expect(res.status).toBe(401)
    })

    test('rejects an invalid token', async () => {
        const res = await createApp().request('/api/sessions', {
            headers: { authorization: 'Bearer garbage' }
        })
        expect(res.status).toBe(401)
    })

    test('accepts a legacy JWT and sets uid/ns', async () => {
        const token = await signHapiToken({ uid: 7, ns: 'default' })
        const res = await createApp().request('/api/sessions', {
            headers: { authorization: `Bearer ${token}` }
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ userId: 7, namespace: 'default' })
    })

    test('accepts a legacy JWT via the SSE query parameter', async () => {
        const token = await signHapiToken({ uid: 8, ns: 'work' })
        const res = await createApp().request(`/api/events?token=${encodeURIComponent(token)}`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ userId: 8, namespace: 'work' })
    })

    test('keeps the existing auth exclusions', async () => {
        const app = createApp()
        expect((await app.request('/api/auth', { method: 'POST' })).status).toBe(200)
        expect((await app.request('/api/bind', { method: 'POST' })).status).toBe(200)
    })

    test('rejects a Cloudflare-marked JWT when Cloudflare is disabled', async () => {
        const token = await signHapiToken({ uid: 9, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: null }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': 'present-but-irrelevant'
            }
        })
        expect(res.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT without a current assertion', async () => {
        const token = await signHapiToken({ uid: 10, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: { authorization: `Bearer ${token}` }
        })
        expect(res.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT with an invalid assertion', async () => {
        const token = await signHapiToken({ uid: 11, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': 'garbage'
            }
        })
        expect(res.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT whose email is not allowlisted', async () => {
        const assertion = await signAccessAssertion({ email: 'mallory@example.com' })
        const token = await signHapiToken({ uid: 12, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'mallory@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': assertion
            }
        })
        expect(res.status).toBe(403)
    })

    test('returns 503 when the key service is unavailable', async () => {
        const assertion = await signAccessAssertion()
        const unavailable = createCloudflareAccessVerifier(CF_CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const token = await signHapiToken({ uid: 13, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: unavailable }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': assertion
            }
        })
        expect(res.status).toBe(503)
    })

    test('rejects an assertion whose subject doesn\'t match the JWT', async () => {
        const assertion = await signAccessAssertion({ sub: 'subject-other' })
        const token = await signHapiToken({ uid: 14, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': assertion
            }
        })
        expect(res.status).toBe(401)
    })

    test('accepts a Cloudflare-marked JWT with a matching current assertion', async () => {
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 15, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: {
                authorization: `Bearer ${token}`,
                'Cf-Access-Jwt-Assertion': assertion
            }
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ userId: 15, namespace: 'default' })
    })

    test('a valid Cloudflare-derived HAPI JWT alone cannot authenticate', async () => {
        const token = await signHapiToken({ uid: 16, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const res = await createApp({ cloudflareAccessVerifier: await localVerifier() }).request('/api/sessions', {
            headers: { authorization: `Bearer ${token}` }
        })
        expect(res.status).toBe(401)
        const body = await res.json() as { error?: string }
        expect(body.error).toBeDefined()
        expect(JSON.stringify(body)).not.toContain('subject-1')
    })
})

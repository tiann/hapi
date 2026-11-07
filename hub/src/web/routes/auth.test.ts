import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createConfiguration } from '../../configuration'
import type { CloudflareAccessConfig } from '../../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from '../cloudflareAccess'
import { createAuthRoutes } from './auth'
import type { Store } from '../../store'

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

function decodeJwt(token: string): Record<string, unknown> {
    const payload = token.split('.')[1] ?? ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8')) as Record<string, unknown>
}

function createApp(options: { cloudflareAccessVerifier?: CloudflareAccessVerifier | null } = {}) {
    const app = new Hono()
    app.route('/api', createAuthRoutes(JWT_SECRET, {} as Store, options))
    return app
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

describe('GET /api/auth/methods', () => {
    test('reports the disabled capability with no-store', async () => {
        const res = await createApp({ cloudflareAccessVerifier: null }).request('/api/auth/methods')
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({ cloudflareAccess: false })
    })

    test('reports the enabled capability with no-store', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const res = await app.request('/api/auth/methods')
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(await res.json()).toEqual({ cloudflareAccess: true })
    })
})

describe('GET /api/auth/cloudflare', () => {
    test('returns 404 when Cloudflare Access is disabled', async () => {
        const res = await createApp({ cloudflareAccessVerifier: null }).request('/api/auth/cloudflare')
        expect(res.status).toBe(404)
        expect(res.headers.get('cache-control')).toBe('no-store')
    })

    test('returns 401 when the assertion is missing', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const res = await app.request('/api/auth/cloudflare')
        expect(res.status).toBe(401)
        expect(res.headers.get('cache-control')).toBe('no-store')
    })

    test('returns 401 for an invalid assertion', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const res = await app.request('/api/auth/cloudflare', {
            headers: { 'Cf-Access-Jwt-Assertion': 'garbage' }
        })
        expect(res.status).toBe(401)
    })

    test('returns 403 for an allowlisted-domain but unlisted email', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const assertion = await signAccessAssertion({ email: 'mallory@example.com' })
        const res = await app.request('/api/auth/cloudflare', {
            headers: { 'Cf-Access-Jwt-Assertion': assertion }
        })
        expect(res.status).toBe(403)
    })

    test('returns 503 when the key service is unavailable', async () => {
        const unavailable = createCloudflareAccessVerifier(CF_CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const app = createApp({ cloudflareAccessVerifier: unavailable })
        const assertion = await signAccessAssertion()
        const res = await app.request('/api/auth/cloudflare', {
            headers: { 'Cf-Access-Jwt-Assertion': assertion }
        })
        expect(res.status).toBe(503)
    })

    test('exchanges a valid assertion for a bound HAPI JWT', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const assertion = await signAccessAssertion()
        const res = await app.request('/api/auth/cloudflare', {
            headers: { 'Cf-Access-Jwt-Assertion': assertion }
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('cache-control')).toBe('no-store')

        const body = await res.json() as { token: string; user: { id: number; firstName?: string } }
        expect(typeof body.token).toBe('string')
        expect(body.user.id).toBeGreaterThan(0)
        expect(body.user.firstName).toBe('Web User')
        expect(JSON.stringify(body)).not.toContain('CLI_API_TOKEN')

        const payload = decodeJwt(body.token)
        expect(payload.authMethod).toBe('cloudflareAccess')
        expect(payload.ns).toBe('default')
        expect(payload.cfAccessSub).toBe('subject-1')
        expect(payload.cfAccessEmail).toBe('alice@example.com')
        expect(typeof payload.uid).toBe('number')

        // Bound lifetime: min(now+4h, verified Access exp). The assertion
        // expires in 1h, so the HAPI JWT must not outlive it.
        const assertionPayload = decodeJwt(assertion)
        expect(payload.exp).toBe(assertionPayload.exp)
        expect(payload.exp as number).toBeLessThan(Math.floor(Date.now() / 1000) + 4 * 3600)
    })

    test('caps the HAPI JWT at 4h when the assertion lives longer', async () => {
        const app = createApp({ cloudflareAccessVerifier: await localVerifier() })
        const assertion = await new SignJWT({ sub: 'subject-2', email: 'alice@example.com' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISSUER)
            .setAudience(CF_CONFIG.audience)
            .setIssuedAt()
            .setExpirationTime('8h')
            .sign(keyPair.privateKey)
        const res = await app.request('/api/auth/cloudflare', {
            headers: { 'Cf-Access-Jwt-Assertion': assertion }
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string }
        const payload = decodeJwt(body.token)
        const expectedExp = Math.floor(Date.now() / 1000) + 4 * 3600
        expect(Math.abs((payload.exp as number) - expectedExp)).toBeLessThan(5)
    })
})

describe('POST /api/auth (unchanged contract)', () => {
    test('still authenticates the CLI access token', async () => {
        const res = await createApp().request('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: 'test-token' })
        })
        expect(res.status).toBe(200)
        const body = await res.json() as { token: string; user: { firstName?: string } }
        expect(body.user.firstName).toBe('Web User')
        expect(decodeJwt(body.token).ns).toBe('default')
    })

    test('still rejects a bad access token', async () => {
        const res = await createApp().request('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: 'wrong-token' })
        })
        expect(res.status).toBe(401)
    })
})

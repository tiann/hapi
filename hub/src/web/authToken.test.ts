import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from './cloudflareAccess'
import { verifyWebAuthToken } from './authToken'

const JWT_SECRET = new TextEncoder().encode('test-secret')

const CF_CONFIG: CloudflareAccessConfig = {
    teamDomain: 'synthetic.cloudflareaccess.com',
    audience: 'synthetic-audience',
    users: {
        'alice@example.com': 'default',
        'bob@example.com': 'work'
    }
}

const ISSUER = 'https://synthetic.cloudflareaccess.com'

let keyPair: { publicKey: CryptoKey; privateKey: CryptoKey }
let jwks: { keys: Array<Record<string, string>> }

async function initKeys() {
    if (keyPair) return
    keyPair = await generateKeyPair('RS256')
    jwks = { keys: [await exportJWK(keyPair.publicKey) as unknown as Record<string, string>] }
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

async function localVerifier(): Promise<CloudflareAccessVerifier> {
    await initKeys()
    return createCloudflareAccessVerifier(CF_CONFIG, { keyResolver: createLocalJWKSet(jwks) })
}

async function signHapiToken(payload: Record<string, unknown>): Promise<string> {
    return await new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
}

describe('verifyWebAuthToken', () => {
    test('accepts a legacy JWT without authMethod', async () => {
        const token = await signHapiToken({ uid: 7, ns: 'default' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined)
        expect(result).toEqual({ ok: true, userId: 7, namespace: 'default' })
    })

    test('accepts a legacy JWT carrying unrelated extra claims', async () => {
        const token = await signHapiToken({ uid: 8, ns: 'work', theme: 'dark' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined)
        expect(result).toEqual({ ok: true, userId: 8, namespace: 'work' })
    })

    test('rejects a malformed token', async () => {
        const result = await verifyWebAuthToken('not-a-jwt', JWT_SECRET, undefined)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a token signed with the wrong secret', async () => {
        const token = await new SignJWT({ uid: 9, ns: 'default' })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(new TextEncoder().encode('other-secret'))
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a token with a non-numeric uid', async () => {
        const token = await signHapiToken({ uid: '7', ns: 'default' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects an unknown authMethod', async () => {
        const token = await signHapiToken({ uid: 10, ns: 'default', authMethod: 'oidc' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT missing cfAccessSub', async () => {
        const token = await signHapiToken({ uid: 11, ns: 'default', authMethod: 'cloudflareAccess', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT missing cfAccessEmail', async () => {
        const token = await signHapiToken({ uid: 12, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT with malformed marker fields', async () => {
        const token = await signHapiToken({ uid: 13, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 42, cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT when Cloudflare configuration is disabled', async () => {
        const token = await signHapiToken({ uid: 14, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: null })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT without a current assertion', async () => {
        const token = await signHapiToken({ uid: 15, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, undefined, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT whose assertion is invalid', async () => {
        const token = await signHapiToken({ uid: 16, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, 'garbage-assertion', { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects a Cloudflare-marked JWT whose assertion email is not allowlisted', async () => {
        await initKeys()
        const assertion = await signAccessAssertion({ email: 'mallory@example.com' })
        const token = await signHapiToken({ uid: 17, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'mallory@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(403)
    })

    test('rejects a Cloudflare-marked JWT when the key service is unavailable', async () => {
        await initKeys()
        const assertion = await signAccessAssertion()
        const unavailable = createCloudflareAccessVerifier(CF_CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const token = await signHapiToken({ uid: 18, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: unavailable })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(503)
    })

    test('rejects an assertion whose subject differs from the HAPI JWT', async () => {
        await initKeys()
        const assertion = await signAccessAssertion({ sub: 'subject-other' })
        const token = await signHapiToken({ uid: 19, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects an assertion whose email differs from the HAPI JWT', async () => {
        await initKeys()
        const assertion = await signAccessAssertion({ email: 'bob@example.com' })
        const token = await signHapiToken({ uid: 20, ns: 'work', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('rejects an assertion whose mapped namespace differs from the HAPI JWT', async () => {
        await initKeys()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 21, ns: 'other', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.status).toBe(401)
    })

    test('accepts a Cloudflare-marked JWT with a matching current assertion', async () => {
        await initKeys()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 22, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: await localVerifier() })
        expect(result).toEqual({ ok: true, userId: 22, namespace: 'default' })
    })

    test('failure results never leak the assertion or claims', async () => {
        await initKeys()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 23, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyWebAuthToken(token, JWT_SECRET, assertion, { cloudflareAccessVerifier: null })
        expect(result.ok).toBe(false)
        expect(JSON.stringify(result)).not.toContain(assertion)
        expect(JSON.stringify(result)).not.toContain('subject-1')
    })
})

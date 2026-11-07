import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from '../web/cloudflareAccess'
import { verifyTerminalSocketAuth } from './server'

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

describe('verifyTerminalSocketAuth', () => {
    test('rejects a missing token', async () => {
        const result = await verifyTerminalSocketAuth(null, undefined, JWT_SECRET)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toBe('Missing token')
    })

    test('rejects an invalid token', async () => {
        const result = await verifyTerminalSocketAuth('garbage', undefined, JWT_SECRET)
        expect(result.ok).toBe(false)
    })

    test('accepts a legacy JWT', async () => {
        const token = await signHapiToken({ uid: 7, ns: 'default' })
        const result = await verifyTerminalSocketAuth(token, undefined, JWT_SECRET)
        expect(result).toEqual({ ok: true, userId: 7, namespace: 'default' })
    })

    test('reads the forwarded assertion from a string header', async () => {
        const verifier = await localVerifier()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 8, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, assertion, JWT_SECRET, { cloudflareAccessVerifier: verifier })
        expect(result).toEqual({ ok: true, userId: 8, namespace: 'default' })
    })

    test('reads the forwarded assertion from an array header', async () => {
        const verifier = await localVerifier()
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 9, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, [assertion], JWT_SECRET, { cloudflareAccessVerifier: verifier })
        expect(result).toEqual({ ok: true, userId: 9, namespace: 'default' })
    })

    test('treats an empty array header as a missing assertion', async () => {
        const token = await signHapiToken({ uid: 10, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, [], JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
    })

    test('a valid Cloudflare-derived HAPI JWT alone cannot authenticate', async () => {
        const token = await signHapiToken({ uid: 11, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, undefined, JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
    })

    test('rejects a marked JWT when Cloudflare is disabled', async () => {
        const assertion = await signAccessAssertion()
        const token = await signHapiToken({ uid: 12, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, assertion, JWT_SECRET, { cloudflareAccessVerifier: null })
        expect(result.ok).toBe(false)
    })

    test('rejects an invalid assertion', async () => {
        const token = await signHapiToken({ uid: 13, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, 'garbage', JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
    })

    test('rejects an unlisted email', async () => {
        const assertion = await signAccessAssertion({ email: 'mallory@example.com' })
        const token = await signHapiToken({ uid: 14, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'mallory@example.com' })
        const result = await verifyTerminalSocketAuth(token, assertion, JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
    })

    test('surfaces key-service unavailability', async () => {
        const assertion = await signAccessAssertion()
        const unavailable = createCloudflareAccessVerifier(CF_CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const token = await signHapiToken({ uid: 15, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, assertion, JWT_SECRET, { cloudflareAccessVerifier: unavailable })
        expect(result.ok).toBe(false)
    })

    test('rejects an assertion whose subject doesn\'t match the JWT', async () => {
        const assertion = await signAccessAssertion({ sub: 'subject-other' })
        const token = await signHapiToken({ uid: 16, ns: 'default', authMethod: 'cloudflareAccess', cfAccessSub: 'subject-1', cfAccessEmail: 'alice@example.com' })
        const result = await verifyTerminalSocketAuth(token, assertion, JWT_SECRET, { cloudflareAccessVerifier: await localVerifier() })
        expect(result.ok).toBe(false)
    })
})

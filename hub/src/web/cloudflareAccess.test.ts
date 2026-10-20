import { afterEach, describe, expect, test } from 'bun:test'
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type JWTHeaderParameters } from 'jose'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { createCloudflareAccessVerifier } from './cloudflareAccess'

const CONFIG: CloudflareAccessConfig = {
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

async function signAssertion(
    claims: Record<string, unknown>,
    options: { algorithm?: string; kid?: string; key?: CryptoKey; issuer?: string; audience?: string } = {}
): Promise<string> {
    const header: JWTHeaderParameters = { alg: options.algorithm ?? 'RS256' }
    if (options.kid) header.kid = options.kid
    return await new SignJWT(claims)
        .setProtectedHeader(header)
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? CONFIG.audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(options.key ?? keyPair.privateKey)
}

function localVerifier(): ReturnType<typeof createCloudflareAccessVerifier> {
    return createCloudflareAccessVerifier(CONFIG, { keyResolver: createLocalJWKSet(jwks) })
}

describe('createCloudflareAccessVerifier', () => {
    test('returns verified subject, normalized email, mapped namespace and expiry', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-1', email: 'Alice@Example.com' })
        const result = await localVerifier().verify(assertion)
        expect(result).toEqual({
            kind: 'ok',
            subject: 'subject-1',
            email: 'alice@example.com',
            namespace: 'default',
            expiresAt: expect.any(Number)
        })
    })

    test('maps distinct allowlisted emails to their namespaces', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-2', email: 'bob@example.com' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('ok')
        if (result.kind === 'ok') {
            expect(result.namespace).toBe('work')
        }
    })

    test('rejects an empty assertion as invalid', async () => {
        await initKeys()
        const result = await localVerifier().verify('')
        expect(result.kind).toBe('invalid')
    })

    test('rejects assertions exceeding 16 KiB', async () => {
        await initKeys()
        const assertion = await signAssertion({
            sub: 'subject-3',
            email: 'alice@example.com',
            pad: 'x'.repeat(17_000)
        })
        expect(new TextEncoder().encode(assertion).byteLength).toBeGreaterThan(16 * 1024)
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a forged signature', async () => {
        await initKeys()
        const other = await generateKeyPair('RS256')
        const assertion = await signAssertion(
            { sub: 'subject-4', email: 'alice@example.com' },
            { key: other.privateKey }
        )
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a non-RS256 algorithm', async () => {
        await initKeys()
        const hmacKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode('test-secret'),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        )
        const assertion = await signAssertion(
            { sub: 'subject-5', email: 'alice@example.com' },
            { algorithm: 'HS256', key: hmacKey }
        )
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a wrong issuer', async () => {
        await initKeys()
        const assertion = await signAssertion(
            { sub: 'subject-6', email: 'alice@example.com' },
            { issuer: 'https://other.cloudflareaccess.com' }
        )
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a wrong audience', async () => {
        await initKeys()
        const assertion = await signAssertion(
            { sub: 'subject-7', email: 'alice@example.com' },
            { audience: 'other-audience' }
        )
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a missing exp', async () => {
        await initKeys()
        const assertion = await new SignJWT({ sub: 'subject-8', email: 'alice@example.com' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISSUER)
            .setAudience(CONFIG.audience)
            .setIssuedAt()
            .sign(keyPair.privateKey)
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects an expired assertion', async () => {
        await initKeys()
        const assertion = await new SignJWT({ sub: 'subject-9', email: 'alice@example.com' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISSUER)
            .setAudience(CONFIG.audience)
            .setIssuedAt()
            .setExpirationTime('1s')
            .sign(keyPair.privateKey)
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a non-integer exp', async () => {
        await initKeys()
        const assertion = await new SignJWT({ sub: 'subject-10', email: 'alice@example.com', exp: 1.5 })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISSUER)
            .setAudience(CONFIG.audience)
            .setIssuedAt()
            .sign(keyPair.privateKey)
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a missing sub', async () => {
        await initKeys()
        const assertion = await signAssertion({ email: 'alice@example.com' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects an empty sub', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: '', email: 'alice@example.com' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a missing email', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-11' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a malformed email', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-12', email: 'not-an-email' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('rejects a valid email that is not in the allowlist', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-13', email: 'mallory@example.com' })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('forbidden')
    })

    test('reports unavailable when the key service cannot be reached', async () => {
        await initKeys()
        const verifier = createCloudflareAccessVerifier(CONFIG, {
            keyResolver: () => Promise.reject(new TypeError('fetch failed'))
        })
        const assertion = await signAssertion({ sub: 'subject-14', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
    })

    test('reports unavailable on JWKS timeout', async () => {
        await initKeys()
        const verifier = createCloudflareAccessVerifier(CONFIG, {
            keyResolver: () => Promise.reject(new errors.JWKSTimeout())
        })
        const assertion = await signAssertion({ sub: 'subject-15', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
    })

    test('reports invalid when the JWKS is fetched but has no matching key', async () => {
        await initKeys()
        const verifier = createCloudflareAccessVerifier(CONFIG, {
            keyResolver: () => Promise.reject(new errors.JWKSNoMatchingKey())
        })
        const assertion = await signAssertion({ sub: 'subject-16', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('invalid')
    })

    test('failure results never leak the assertion', async () => {
        await initKeys()
        const assertion = await signAssertion({ sub: 'subject-17', email: 'mallory@example.com' })
        const result = await localVerifier().verify(assertion)
        expect(JSON.stringify(result)).not.toContain(assertion)
        expect(JSON.stringify(result)).not.toContain('mallory')
    })

    test('accepts assertions carrying extra IdP claims', async () => {
        await initKeys()
        const assertion = await signAssertion({
            sub: 'subject-18',
            email: 'alice@example.com',
            idp: 'https://accounts.google.com',
            custom_claims: { department: 'engineering', groups: ['admins'] },
            country: 'US'
        })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('ok')
        if (result.kind === 'ok') {
            expect(result.subject).toBe('subject-18')
            expect(result.email).toBe('alice@example.com')
        }
    })

    test('rejects a service-like assertion without an email claim', async () => {
        await initKeys()
        const assertion = await signAssertion({
            sub: 'subject-19',
            idp: 'https://accounts.google.com',
            custom_claims: { department: 'engineering' }
        })
        const result = await localVerifier().verify(assertion)
        expect(result.kind).toBe('invalid')
    })
})

describe('createCloudflareAccessVerifier — production remote resolver', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    function useSyntheticFetch(response: Response | Error): void {
        globalThis.fetch = (async () => {
            if (response instanceof Error) throw response
            return response
        }) as unknown as typeof fetch
    }

    test('reports unavailable when the JWKS endpoint returns HTTP 503', async () => {
        await initKeys()
        useSyntheticFetch(new Response('Service Unavailable', { status: 503 }))
        const verifier = createCloudflareAccessVerifier(CONFIG)
        const assertion = await signAssertion({ sub: 'subject-20', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
    })

    test('reports unavailable when the JWKS endpoint returns malformed JSON', async () => {
        await initKeys()
        useSyntheticFetch(new Response('not json at all', {
            status: 200,
            headers: { 'content-type': 'application/json' }
        }))
        const verifier = createCloudflareAccessVerifier(CONFIG)
        const assertion = await signAssertion({ sub: 'subject-21', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
    })

    test('reports unavailable when the JWKS endpoint is unreachable', async () => {
        await initKeys()
        useSyntheticFetch(new TypeError('fetch failed'))
        const verifier = createCloudflareAccessVerifier(CONFIG)
        const assertion = await signAssertion({ sub: 'subject-22', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
    })

    test('derives issuer and JWKS URL only from the configured team domain', async () => {
        await initKeys()
        const requestedUrls: string[] = []
        globalThis.fetch = (async (input: string | URL) => {
            requestedUrls.push(String(input))
            return new Response('Service Unavailable', { status: 503 })
        }) as unknown as typeof fetch
        const verifier = createCloudflareAccessVerifier(CONFIG)
        const assertion = await signAssertion({ sub: 'subject-23', email: 'alice@example.com' })
        const result = await verifier.verify(assertion)
        expect(result.kind).toBe('unavailable')
        expect(requestedUrls).toEqual(['https://synthetic.cloudflareaccess.com/cdn-cgi/access/certs'])
    })
})

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createConfiguration } from '../configuration'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import type { Store } from '../store'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from '../web/cloudflareAccess'
import { createSocketServer, verifyTerminalSocketAuth } from './server'

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

describe('createSocketServer — live /terminal handshake and origin gate', () => {
    let server: { port: number; stop: (force?: boolean) => void } | null = null
    let wsUrl = ''
    let originalCloudflareAccess: CloudflareAccessConfig | null = null
    const originalFetch = globalThis.fetch

    beforeAll(async () => {
        await initKeys()
        const config = await createConfiguration()
        originalCloudflareAccess = config.cloudflareAccess
        const mutableConfig = config as unknown as { cloudflareAccess: CloudflareAccessConfig | null }
        mutableConfig.cloudflareAccess = {
            teamDomain: CF_CONFIG.teamDomain,
            audience: CF_CONFIG.audience,
            users: {
                'alice@example.com': 'default',
                'bob@example.com': 'work'
            }
        }

        const jwkWithKid = { ...jwks.keys[0], kid: 'socket-key-1', use: 'sig', alg: 'RS256' }
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === `https://${CF_CONFIG.teamDomain}/cdn-cgi/access/certs`) {
                return new Response(JSON.stringify({ keys: [jwkWithKid] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                })
            }
            return originalFetch(input, init)
        }) as unknown as typeof fetch

        const socketServer = createSocketServer({
            jwtSecret: JWT_SECRET,
            store: {} as Store,
            corsOrigins: ['https://app.example.com']
        })
        const handler = socketServer.engine.handler()
        server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            websocket: handler.websocket,
            fetch: (req, srv) => handler.fetch(req, srv)
        }) as unknown as { port: number; stop: (force?: boolean) => void }
        wsUrl = `ws://127.0.0.1:${server.port}/socket.io/?EIO=4&transport=websocket`
    })

    afterAll(async () => {
        globalThis.fetch = originalFetch
        server?.stop(true)
        server = null
        const config = await createConfiguration()
        const mutableConfig = config as unknown as { cloudflareAccess: CloudflareAccessConfig | null }
        mutableConfig.cloudflareAccess = originalCloudflareAccess
    })

    async function signKidAssertion(claims: Record<string, unknown>): Promise<string> {
        return await new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'socket-key-1' })
            .setIssuer(ISSUER)
            .setAudience(CF_CONFIG.audience)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(keyPair.privateKey)
    }

    function connectTerminalNamespace(
        token: string,
        headers: Record<string, string>
    ): Promise<{ outcome: 'connected' | 'rejected' | 'transport-error'; payload?: string }> {
        return new Promise((resolve) => {
            const ws = new WebSocket(wsUrl, { headers } as never)
            const timer = setTimeout(() => {
                ws.close()
                resolve({ outcome: 'transport-error' })
            }, 3000)

            ws.onmessage = (event) => {
                const msg = String(event.data)
                if (msg.startsWith('0')) {
                    ws.send(`40/terminal,${JSON.stringify({ token })}`)
                    return
                }
                if (msg.startsWith('40/terminal')) {
                    clearTimeout(timer)
                    ws.close()
                    resolve({ outcome: 'connected', payload: msg })
                    return
                }
                if (msg.startsWith('44/terminal')) {
                    clearTimeout(timer)
                    ws.close()
                    resolve({ outcome: 'rejected', payload: msg })
                }
            }

            ws.onerror = () => {
                clearTimeout(timer)
                resolve({ outcome: 'transport-error' })
            }
        })
    }

    test('rejects disallowed Origin headers via allowRequest', async () => {
        const res = await fetch(`http://127.0.0.1:${server!.port}/socket.io/?EIO=4&transport=polling`, {
            headers: { Origin: 'https://evil.example' }
        })
        expect(res.status).toBeGreaterThanOrEqual(400)
    })

    test('rejects a bound /terminal handshake without Cf-Access-Jwt-Assertion', async () => {
        const token = await signHapiToken({
            uid: 1,
            ns: 'work',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'bob-sub',
            cfAccessEmail: 'bob@example.com'
        })
        const result = await connectTerminalNamespace(token, {
            Origin: 'https://app.example.com'
        })
        expect(result.outcome).toBe('rejected')
    })

    test('accepts a bound /terminal handshake with a matching Cf-Access-Jwt-Assertion', async () => {
        const assertion = await signKidAssertion({ sub: 'bob-sub', email: 'bob@example.com' })
        const token = await signHapiToken({
            uid: 1,
            ns: 'work',
            authMethod: 'cloudflareAccess',
            cfAccessSub: 'bob-sub',
            cfAccessEmail: 'bob@example.com'
        })
        const result = await connectTerminalNamespace(token, {
            Origin: 'https://app.example.com',
            'Cf-Access-Jwt-Assertion': assertion
        })
        expect(result.outcome).toBe('connected')
    })
})

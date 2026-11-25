import { afterAll, afterEach, beforeAll, describe, expect, it, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { createConfiguration } from '../configuration'
import type { CloudflareAccessConfig } from '../config/cloudflareAccess'
import { createCloudflareAccessVerifier, type CloudflareAccessVerifier } from './cloudflareAccess'
import { authorizeVoiceWebSocketRequest, createWebApp, startWebServer } from './server'
import type { EmbeddedWebAsset } from './embeddedAssets'
import { Store } from '../store'

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

describe('live server with Cloudflare Access enabled (production verifier wiring)', () => {
    let server: { port: number; stop: (force?: boolean) => void } | null = null
    let baseUrl = ''
    let originalCloudflareAccess: CloudflareAccessConfig | null = null
    let originalListenPort = 3006
    const originalFetch = globalThis.fetch

    beforeAll(async () => {
        await initKeys()
        const config = await createConfiguration()
        originalCloudflareAccess = config.cloudflareAccess
        originalListenPort = config.listenPort

        const mutableConfig = config as unknown as {
            cloudflareAccess: CloudflareAccessConfig | null
            listenPort: number
        }
        mutableConfig.listenPort = 0
        mutableConfig.cloudflareAccess = {
            teamDomain: CF_CONFIG.teamDomain,
            audience: CF_CONFIG.audience,
            users: {
                'alice@example.com': 'default',
                'bob@example.com': 'work'
            }
        }

        const jwkWithKid = { ...jwks.keys[0], kid: 'test-key-1', use: 'sig', alg: 'RS256' }
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

    afterAll(async () => {
        globalThis.fetch = originalFetch
        server?.stop(true)
        server = null
        const config = await createConfiguration()
        const mutableConfig = config as unknown as {
            cloudflareAccess: CloudflareAccessConfig | null
            listenPort: number
        }
        mutableConfig.cloudflareAccess = originalCloudflareAccess
        mutableConfig.listenPort = originalListenPort
    })

    async function signKidAssertion(claims: Record<string, unknown>): Promise<string> {
        return await new SignJWT(claims)
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
            .setIssuer(ISSUER)
            .setAudience(CF_CONFIG.audience)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(keyPair.privateKey)
    }

    test('exchanges assertions via production verifier and enforces binding across HTTP and voice WS', async () => {
        const methodsRes = await fetch(`${baseUrl}/api/auth/methods`)
        expect(methodsRes.status).toBe(200)
        expect(await methodsRes.json()).toEqual({ cloudflareAccess: true })

        const bobAssertion = await signKidAssertion({ sub: 'bob-sub', email: 'bob@example.com' })
        const exchangeRes = await fetch(`${baseUrl}/api/auth/cloudflare`, {
            headers: { 'Cf-Access-Jwt-Assertion': bobAssertion }
        })
        expect(exchangeRes.status).toBe(200)
        const { token: bobJwt } = await exchangeRes.json() as { token: string }

        // Protected HTTP route requires both the HAPI JWT and a matching assertion.
        const missingAssertionRes = await fetch(`${baseUrl}/api/hub-settings`, {
            headers: { Authorization: `Bearer ${bobJwt}` }
        })
        expect(missingAssertionRes.status).toBe(401)

        const aliceAssertion = await signKidAssertion({ sub: 'alice-sub', email: 'alice@example.com' })
        const mismatchRes = await fetch(`${baseUrl}/api/hub-settings`, {
            headers: {
                Authorization: `Bearer ${bobJwt}`,
                'Cf-Access-Jwt-Assertion': aliceAssertion
            }
        })
        expect(mismatchRes.status).toBe(401)

        const allowedRes = await fetch(`${baseUrl}/api/hub-settings`, {
            headers: {
                Authorization: `Bearer ${bobJwt}`,
                'Cf-Access-Jwt-Assertion': bobAssertion
            }
        })
        expect(allowedRes.status).toBe(200)

        // Namespace derived from allowlist ('work') is enforced on owner-only routes.
        const ownerOnlyRes = await fetch(`${baseUrl}/api/usage/summary`, {
            headers: {
                Authorization: `Bearer ${bobJwt}`,
                'Cf-Access-Jwt-Assertion': bobAssertion
            }
        })
        expect(ownerOnlyRes.status).toBe(403)

        // SSE endpoint also enforces the bound assertion when Cloudflare-derived.
        const sseMissingAssertion = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(bobJwt)}`)
        expect(sseMissingAssertion.status).toBe(401)

        // Voice WebSocket upgrade gate uses the same production verifier wiring.
        const voiceWithoutAssertion = await fetch(`${baseUrl}/api/voice/gemini-ws?token=${encodeURIComponent(bobJwt)}`)
        expect(voiceWithoutAssertion.status).toBe(401)

        const voiceWithAssertion = await fetch(`${baseUrl}/api/voice/gemini-ws?token=${encodeURIComponent(bobJwt)}`, {
            headers: { 'Cf-Access-Jwt-Assertion': bobAssertion }
        })
        expect(voiceWithAssertion.status).toBe(400)
        expect(await voiceWithAssertion.text()).toBe('Gemini API key not configured')
    })
})

const HTML_BODY = `<!doctype html><html><head><title>HAPI</title></head><body><div id="root">${'<span>hapi-shell</span>'.repeat(160)}</div></body></html>`
const JS_BODY = `// main bundle\nexport const payload = ${JSON.stringify('abcdef0123456789'.repeat(200))};\nconsole.log(payload.length);\n`
const CSS_BODY = `/* styles */\n${'.app-shell { color: #111; background: #fff; padding: 12px; }\n'.repeat(80)}`
const SW_BODY = `// service worker\nself.addEventListener('fetch', () => {});\n${'// cache-entry\n'.repeat(180)}`
const MANIFEST_BODY = JSON.stringify({
    name: 'HAPI',
    short_name: 'HAPI',
    description: 'remote agent interface '.repeat(120),
    display: 'standalone'
})
const PNG_BYTES = new Uint8Array(3000).fill(0x89)
const WOFF2_BYTES = new Uint8Array(3000).fill(0x77)

const stores: Store[] = []
function newStore(): Store {
    const store = new Store(':memory:')
    stores.push(store)
    return store
}

let homeDir = ''
let previousHapiHome: string | undefined
let distDir = ''
let embeddedAssetMap = new Map<string, EmbeddedWebAsset>()

function writeFixture(relPath: string, content: string | Uint8Array): string {
    const fullPath = join(distDir, relPath.replace(/^\//, ''))
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
    return fullPath
}

beforeAll(async () => {
    previousHapiHome = process.env.HAPI_HOME
    homeDir = mkdtempSync(join(tmpdir(), 'hapi-web-server-home-'))
    process.env.HAPI_HOME = homeDir
    await createConfiguration()

    distDir = mkdtempSync(join(tmpdir(), 'hapi-web-server-dist-'))
    const indexPath = writeFixture('/index.html', HTML_BODY)
    const jsPath = writeFixture('/assets/index-test.js', JS_BODY)
    const cssPath = writeFixture('/assets/index-test.css', CSS_BODY)
    const swPath = writeFixture('/sw.js', SW_BODY)
    const manifestPath = writeFixture('/manifest.webmanifest', MANIFEST_BODY)
    const pngPath = writeFixture('/pwa-192x192.png', PNG_BYTES)
    const woff2Path = writeFixture('/assets/fonts/test.woff2', WOFF2_BYTES)

    embeddedAssetMap = new Map<string, EmbeddedWebAsset>([
        ['/index.html', { path: '/index.html', sourcePath: indexPath, mimeType: 'text/html; charset=utf-8' }],
        ['/assets/index-test.js', { path: '/assets/index-test.js', sourcePath: jsPath, mimeType: 'text/javascript; charset=utf-8' }],
        ['/assets/index-test.css', { path: '/assets/index-test.css', sourcePath: cssPath, mimeType: 'text/css; charset=utf-8' }],
        ['/sw.js', { path: '/sw.js', sourcePath: swPath, mimeType: 'text/javascript; charset=utf-8' }],
        ['/manifest.webmanifest', { path: '/manifest.webmanifest', sourcePath: manifestPath, mimeType: 'application/manifest+json; charset=utf-8' }],
        ['/pwa-192x192.png', { path: '/pwa-192x192.png', sourcePath: pngPath, mimeType: 'image/png' }],
        ['/assets/fonts/test.woff2', { path: '/assets/fonts/test.woff2', sourcePath: woff2Path, mimeType: 'font/woff2' }]
    ])
})

afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close()
    }
})

afterAll(() => {
    if (previousHapiHome === undefined) {
        delete process.env.HAPI_HOME
    } else {
        process.env.HAPI_HOME = previousHapiHome
    }
    // homeDir is deliberately left in place. createConfiguration() is a
    // process-wide singleton and bun runs every test file in one process, so
    // test files that run after this one still write settings under homeDir;
    // removing it made routes/cli.test.ts fail with ENOENT whenever it ran later.
    if (distDir) {
        rmSync(distDir, { recursive: true, force: true })
    }
})

function buildApp(mode: 'embeddedAssetMap' | 'distDir') {
    return createWebApp({
        getSyncEngine: () => null,
        getSseManager: () => null,
        getVisibilityTracker: () => null,
        jwtSecret: JWT_SECRET,
        store: newStore(),
        vapidPublicKey: 'test-vapid-public-key',
        embeddedAssetMap: mode === 'embeddedAssetMap' ? embeddedAssetMap : null,
        distDir: mode === 'distDir' ? distDir : undefined
    })
}

describe.each(['embeddedAssetMap', 'distDir'] as const)('web static asset serving (%s)', (mode) => {
    it('gzips HTML, JS, CSS, manifest, sw.js, and SPA fallback when client accepts gzip', async () => {
        const app = buildApp(mode)
        const cases: Array<{ path: string; expected: string }> = [
            { path: '/', expected: HTML_BODY },
            { path: '/assets/index-test.js', expected: JS_BODY },
            { path: '/assets/index-test.css', expected: CSS_BODY },
            { path: '/sw.js', expected: SW_BODY },
            { path: '/manifest.webmanifest', expected: MANIFEST_BODY },
            { path: '/sessions/abc', expected: HTML_BODY }
        ]

        for (const testCase of cases) {
            const res = await app.request(testCase.path, {
                headers: { 'Accept-Encoding': 'gzip, br' }
            })
            expect(res.status).toBe(200)
            expect(res.headers.get('Content-Encoding')).toBe('gzip')
            expect((res.headers.get('Vary') ?? '').toLowerCase()).toContain('accept-encoding')

            const compressed = Buffer.from(await res.arrayBuffer())
            expect(compressed.byteLength).toBeLessThan(Buffer.byteLength(testCase.expected))
            expect(zlib.gunzipSync(compressed).toString('utf8')).toBe(testCase.expected)
        }
    })

    it('honors gzip;q=0 and omitted Accept-Encoding while still sending Vary: Accept-Encoding', async () => {
        const app = buildApp(mode)

        const refused = await app.request('/assets/index-test.js', {
            headers: { 'Accept-Encoding': 'gzip;q=0' }
        })
        expect(refused.status).toBe(200)
        expect(refused.headers.get('Content-Encoding')).toBeNull()
        expect((refused.headers.get('Vary') ?? '').toLowerCase()).toContain('accept-encoding')
        expect(await refused.text()).toBe(JS_BODY)

        const plain = await app.request('/assets/index-test.js')
        expect(plain.status).toBe(200)
        expect(plain.headers.get('Content-Encoding')).toBeNull()
        expect((plain.headers.get('Vary') ?? '').toLowerCase()).toContain('accept-encoding')
        expect(await plain.text()).toBe(JS_BODY)
    })

    it('leaves already-compressed binary PNG and WOFF2 assets uncompressed', async () => {
        const app = buildApp(mode)

        const pngRes = await app.request('/pwa-192x192.png', {
            headers: { 'Accept-Encoding': 'gzip' }
        })
        expect(pngRes.status).toBe(200)
        expect(pngRes.headers.get('Content-Encoding')).toBeNull()
        expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(PNG_BYTES)

        const woffRes = await app.request('/assets/fonts/test.woff2', {
            headers: { 'Accept-Encoding': 'gzip' }
        })
        expect(woffRes.status).toBe(200)
        expect(woffRes.headers.get('Content-Encoding')).toBeNull()
        expect(new Uint8Array(await woffRes.arrayBuffer())).toEqual(WOFF2_BYTES)
    })

    it('sets immutable cache for /assets/*, no-store for /sw.js, and no-cache for HTML and manifest', async () => {
        const app = buildApp(mode)

        const swRes = await app.request('/sw.js')
        expect(swRes.status).toBe(200)
        expect(swRes.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate')
        expect(swRes.headers.get('CDN-Cache-Control')).toBe('no-store')
        expect(swRes.headers.get('Cloudflare-CDN-Cache-Control')).toBe('no-store')

        const jsRes = await app.request('/assets/index-test.js')
        expect(jsRes.status).toBe(200)
        expect(jsRes.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')

        for (const path of ['/', '/index.html', '/manifest.webmanifest', '/sessions/abc']) {
            const res = await app.request(path)
            expect(res.status).toBe(200)
            expect(res.headers.get('Cache-Control')).toBe('no-cache')
        }
    })

    it('returns 404 for missing /assets/* on GET and HEAD instead of falling through to index.html', async () => {
        const app = buildApp(mode)

        for (const method of ['GET', 'HEAD'] as const) {
            const missingAsset = await app.request('/assets/stale-chunk.js', { method })
            expect(missingAsset.status).toBe(404)

            const spaRoute = await app.request('/sessions/abc', { method })
            expect(spaRoute.status).toBe(200)
            expect(spaRoute.headers.get('Content-Type')).toContain('text/html')
            expect(spaRoute.headers.get('Cache-Control')).toBe('no-cache')
        }
    })
})

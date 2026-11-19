import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { createConfiguration, resetConfigurationForTests } from '../configuration'
import { Store } from '../store'
import type { EmbeddedWebAsset } from './embeddedAssets'
import { createWebApp } from './server'

const JWT_SECRET = new Uint8Array(randomBytes(32))

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
    if (homeDir) {
        resetConfigurationForTests(homeDir)
        rmSync(homeDir, { recursive: true, force: true })
    }
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

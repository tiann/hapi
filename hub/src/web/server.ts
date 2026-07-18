import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { serveStatic } from 'hono/bun'
import { configuration } from '../configuration'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { createAuthRoutes } from './routes/auth'
import { createBindRoutes } from './routes/bind'
import { createEventsRoutes } from './routes/events'
import { createSessionsRoutes } from './routes/sessions'
import { createMessagesRoutes } from './routes/messages'
import { createPermissionsRoutes } from './routes/permissions'
import { createMachinesRoutes } from './routes/machines'
import { createGitRoutes } from './routes/git'
import { createCliRoutes } from './routes/cli'
import { createPushRoutes } from './routes/push'
import { createVoiceRoutes } from './routes/voice'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { Server as BunServer } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import type { WebSocketData } from '@socket.io/bun-engine'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { Store } from '../store'
import type { MiddlewareHandler } from 'hono'

const SENSITIVE_QUERY_KEYS = new Set(['token', 'accesstoken', 'authorization', 'auth'])
const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const STATIC_FALLBACK_CACHE_CONTROL = 'no-cache'
const MIN_COMPRESSION_BYTES = 1024
const STATIC_ASSET_EXTENSIONS = new Set([
    'avif', 'css', 'eot', 'gif', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map',
    'mjs', 'otf', 'png', 'svg', 'ttf', 'txt', 'wasm', 'webmanifest', 'webp',
    'woff', 'woff2', 'xml'
])
type CompressionEncoding = 'br' | 'gzip'

function elapsed(start: number): string {
    const delta = Date.now() - start
    return delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`
}

function decodeQueryKey(rawKey: string): string {
    try {
        return decodeURIComponent(rawKey.replace(/\+/g, ' '))
    } catch {
        return rawKey
    }
}

export function sanitizeRequestLogPath(path: string): string {
    const queryIndex = path.indexOf('?')
    if (queryIndex === -1) {
        return path
    }

    const pathname = path.slice(0, queryIndex)
    const query = path.slice(queryIndex + 1)
    if (query.length === 0) {
        return path
    }

    const sanitized = query
        .split('&')
        .map((part) => {
            if (part.length === 0) {
                return part
            }
            const equalsIndex = part.indexOf('=')
            const rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex)
            const key = decodeQueryKey(rawKey).toLowerCase()
            if (!SENSITIVE_QUERY_KEYS.has(key)) {
                return part
            }
            return `${rawKey}=[REDACTED]`
        })
        .join('&')
    return `${pathname}?${sanitized}`
}

function requestLogger(log: (line: string) => void = console.log): MiddlewareHandler {
    return async (c, next) => {
        const { method, url } = c.req
        const rawPath = url.slice(url.indexOf('/', 8))
        const path = sanitizeRequestLogPath(rawPath)
        log(`<-- ${method} ${path}`)
        const start = Date.now()
        await next()
        log(`--> ${method} ${path} ${c.res.status} ${elapsed(start)}`)
    }
}

export function pickCompressionEncoding(acceptEncoding: string | null | undefined): CompressionEncoding | null {
    if (!acceptEncoding) {
        return null
    }

    const accepted = new Map<string, number>()
    for (const rawPart of acceptEncoding.split(',')) {
        const [rawName, ...rawParams] = rawPart.trim().split(';')
        const name = rawName?.trim().toLowerCase()
        if (!name) {
            continue
        }

        let q = 1
        for (const param of rawParams) {
            const [rawKey, rawValue] = param.trim().split('=')
            if (rawKey?.trim().toLowerCase() !== 'q') {
                continue
            }
            const parsed = Number(rawValue)
            q = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0
        }

        accepted.set(name, Math.max(accepted.get(name) ?? 0, q))
    }

    const br = accepted.get('br') ?? (accepted.get('*') ?? 0)
    const gzip = accepted.get('gzip') ?? (accepted.get('*') ?? 0)
    if (br <= 0 && gzip <= 0) {
        return null
    }
    return br >= gzip ? 'br' : 'gzip'
}

export function isCompressibleContentType(contentType: string | null | undefined): boolean {
    if (!contentType) {
        return false
    }
    const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
    if (normalized === 'text/event-stream') {
        return false
    }
    return normalized.startsWith('text/')
        || normalized === 'application/json'
        || normalized === 'application/javascript'
        || normalized === 'application/manifest+json'
        || normalized === 'application/xml'
        || normalized === 'image/svg+xml'
}

export function shouldSkipCompressionForPath(path: string): boolean {
    const pathname = path.split('?')[0] ?? path
    return pathname === '/api/events'
        || pathname.startsWith('/api/events/')
        || pathname.startsWith('/socket.io/')
}

export function addVaryAcceptEncoding(existing: string | null | undefined): string {
    if (!existing || existing.trim().length === 0) {
        return 'Accept-Encoding'
    }
    const values = existing.split(',').map((part) => part.trim()).filter(Boolean)
    if (values.some((value) => value.toLowerCase() === 'accept-encoding')) {
        return existing
    }
    return `${existing}, Accept-Encoding`
}

function compressBody(buffer: Buffer, encoding: CompressionEncoding): Buffer {
    if (encoding === 'br') {
        return brotliCompressSync(buffer, {
            params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: 5
            }
        })
    }
    return gzipSync(buffer, { level: 6 })
}

export function createCompressionMiddleware(): MiddlewareHandler {
    return async (c, next) => {
        await next()

        if (c.req.method === 'HEAD' || c.req.header('range') || shouldSkipCompressionForPath(c.req.path)) {
            return
        }

        const encoding = pickCompressionEncoding(c.req.header('accept-encoding'))
        if (!encoding) {
            return
        }

        const response = c.res
        if (response.status < 200 || response.status === 204 || response.status === 206 || response.status === 304) {
            return
        }
        if (!response.body || response.headers.has('Content-Encoding')) {
            return
        }
        if (!isCompressibleContentType(response.headers.get('Content-Type'))) {
            return
        }

        const declaredLength = Number(response.headers.get('Content-Length') ?? NaN)
        if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength < MIN_COMPRESSION_BYTES) {
            return
        }

        let bodyBuffer: Buffer
        try {
            bodyBuffer = Buffer.from(await response.clone().arrayBuffer())
        } catch {
            return
        }
        if (bodyBuffer.byteLength < MIN_COMPRESSION_BYTES) {
            return
        }

        const compressed = compressBody(bodyBuffer, encoding)
        if (compressed.byteLength >= bodyBuffer.byteLength) {
            return
        }

        const headers = new Headers(response.headers)
        headers.set('Content-Encoding', encoding)
        headers.set('Vary', addVaryAcceptEncoding(headers.get('Vary')))
        headers.set('Content-Length', String(compressed.byteLength))
        headers.delete('ETag')

        c.res = new Response(compressed, {
            status: response.status,
            statusText: response.statusText,
            headers
        })
    }
}

export function createApiNoStoreMiddleware(): MiddlewareHandler {
    return async (c, next) => {
        await next()
        c.header('Cache-Control', 'no-store')
        c.header('Pragma', 'no-cache')
    }
}

function setStaticCacheHeaders(path: string, c: { header: (name: string, value: string) => void }): void {
    if (path.includes('/assets/')) {
        c.header('Cache-Control', STATIC_ASSET_CACHE_CONTROL)
        return
    }
    c.header('Cache-Control', STATIC_FALLBACK_CACHE_CONTROL)
}

export function isStaticAssetRequestPath(path: string): boolean {
    const pathname = path.split(/[?#]/, 1)[0] ?? path
    if (pathname === '/assets' || pathname.startsWith('/assets/')) {
        return true
    }

    const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
    const extensionIndex = lastSegment.lastIndexOf('.')
    if (extensionIndex <= 0 || extensionIndex === lastSegment.length - 1) {
        return false
    }
    return STATIC_ASSET_EXTENSIONS.has(lastSegment.slice(extensionIndex + 1).toLowerCase())
}

function findWebappDistDir(): { distDir: string; indexHtmlPath: string } {
    const candidates = [
        join(process.cwd(), '..', 'web', 'dist'),
        join(import.meta.dir, '..', '..', '..', 'web', 'dist'),
        join(process.cwd(), 'web', 'dist')
    ]

    for (const distDir of candidates) {
        const indexHtmlPath = join(distDir, 'index.html')
        if (existsSync(indexHtmlPath)) {
            return { distDir, indexHtmlPath }
        }
    }

    const distDir = candidates[0]
    return { distDir, indexHtmlPath: join(distDir, 'index.html') }
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
    return new Response(Bun.file(asset.sourcePath), {
        headers: {
            'Content-Type': asset.mimeType,
            'Cache-Control': asset.path.includes('/assets/')
                ? STATIC_ASSET_CACHE_CONTROL
                : STATIC_FALLBACK_CACHE_CONTROL
        }
    })
}

function createWebApp(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    jwtSecret: Uint8Array
    store: Store
    vapidPublicKey: string
    corsOrigins?: string[]
    embeddedAssetMap: Map<string, EmbeddedWebAsset> | null
    relayMode?: boolean
    officialWebUrl?: string
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('*', requestLogger())
    app.use('*', createCompressionMiddleware())
    app.use('/api/*', createApiNoStoreMiddleware())

    // Health check endpoint (no auth required)
    app.get('/health', (c) => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }))

    const corsOrigins = options.corsOrigins ?? configuration.corsOrigins
    const corsOriginOption = corsOrigins.includes('*') ? '*' : corsOrigins
    const corsMiddleware = cors({
        origin: corsOriginOption,
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type']
    })
    app.use('/api/*', corsMiddleware)
    app.use('/cli/*', corsMiddleware)

    app.route('/cli', createCliRoutes(options.getSyncEngine))

    app.route('/api', createAuthRoutes(options.jwtSecret, options.store))
    app.route('/api', createBindRoutes(options.jwtSecret, options.store))

    app.use('/api/*', createAuthMiddleware(options.jwtSecret))
    app.route('/api', createEventsRoutes(options.getSseManager, options.getSyncEngine, options.getVisibilityTracker))
    app.route('/api', createSessionsRoutes(options.getSyncEngine))
    app.route('/api', createMessagesRoutes(options.getSyncEngine))
    app.route('/api', createPermissionsRoutes(options.getSyncEngine))
    app.route('/api', createMachinesRoutes(options.getSyncEngine))
    app.route('/api', createGitRoutes(options.getSyncEngine))
    app.route('/api', createPushRoutes(options.store, options.vapidPublicKey))
    app.route('/api', createVoiceRoutes())

    // Skip static serving in relay mode, show helpful message on root
    if (options.relayMode) {
        const officialUrl = options.officialWebUrl || 'https://app.hapi.run'
        app.get('/', (c) => {
            return c.html(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>HAPI Hub</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 600px;">
<h1>HAPI Hub</h1>
<p>This hub is running in relay mode. Please use the official web app:</p>
<p><a href="${officialUrl}">${officialUrl}</a></p>
<details>
<summary>Why am I seeing this?</summary>
<p style="margin-top: 0.5rem; color: #666;">
When relay mode is enabled, all traffic flows through our relay infrastructure with end-to-end encryption.
To reduce bandwidth and improve performance, the frontend is served separately
from GitHub Pages instead of through the relay tunnel.
</p>
</details>
</body>
</html>`)
        })
        return app
    }

    if (options.embeddedAssetMap) {
        const embeddedAssetMap = options.embeddedAssetMap
        const indexHtmlAsset = embeddedAssetMap.get('/index.html')

        if (!indexHtmlAsset) {
            app.get('*', (c) => {
                return c.text(
                    'Embedded Mini App is missing index.html. Rebuild the executable after running bun run build:web.',
                    503
                )
            })
            return app
        }

        app.use('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                return await next()
            }

            if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
                return await next()
            }

            const asset = embeddedAssetMap.get(c.req.path)
            if (asset) {
                return serveEmbeddedAsset(asset)
            }

            return await next()
        })

        app.get('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                await next()
                return
            }

            if (isStaticAssetRequestPath(c.req.path)) {
                return c.notFound()
            }

            return serveEmbeddedAsset(indexHtmlAsset)
        })

        return app
    }

    const { distDir, indexHtmlPath } = findWebappDistDir()

    if (!existsSync(indexHtmlPath)) {
        app.get('/', (c) => {
            return c.text(
                'Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n',
                503
            )
        })
        return app
    }

    app.use('/assets/*', serveStatic({
        root: distDir,
        onFound: (path, c) => setStaticCacheHeaders(path, c)
    }))

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({
            root: distDir,
            onFound: (path, ctx) => setStaticCacheHeaders(path, ctx)
        })(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        if (isStaticAssetRequestPath(c.req.path)) {
            return c.notFound()
        }

        return await serveStatic({
            root: distDir,
            path: 'index.html',
            onFound: (path, ctx) => setStaticCacheHeaders(path, ctx)
        })(c, next)
    })

    return app
}

export async function startWebServer(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    jwtSecret: Uint8Array
    store: Store
    vapidPublicKey: string
    socketEngine: SocketEngine
    corsOrigins?: string[]
    relayMode?: boolean
    officialWebUrl?: string
}): Promise<BunServer<WebSocketData>> {
    const isCompiled = isBunCompiled()
    const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null
    const app = createWebApp({
        getSyncEngine: options.getSyncEngine,
        getSseManager: options.getSseManager,
        getVisibilityTracker: options.getVisibilityTracker,
        jwtSecret: options.jwtSecret,
        store: options.store,
        vapidPublicKey: options.vapidPublicKey,
        corsOrigins: options.corsOrigins,
        embeddedAssetMap,
        relayMode: options.relayMode,
        officialWebUrl: options.officialWebUrl
    })

    const socketHandler = options.socketEngine.handler()

    const server = Bun.serve({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: Math.max(socketHandler.maxRequestBodySize, 68 * 1024 * 1024),
        websocket: socketHandler.websocket,
        fetch: (req, server) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server)
            }
            return app.fetch(req)
        }
    })

    console.log(`[Web] hub listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)

    return server
}

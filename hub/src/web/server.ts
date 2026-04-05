import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
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
import type { Server as BunServer, ServerWebSocket } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import type { WebSocketData } from '@socket.io/bun-engine'

// Qwen Realtime WebSocket proxy — bridges browser (no custom headers) to DashScope (requires Authorization header)
function createQwenProxyWebSocketHandler() {
    const QWEN_WS_BASE = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
    // Map browser WS → upstream WS
    const upstreamMap = new WeakMap<ServerWebSocket<unknown>, WebSocket>()

    return {
        open(clientWs: ServerWebSocket<unknown>) {
            const data = clientWs.data as { apiKey: string; model: string }
            const upstreamUrl = `${process.env.QWEN_REALTIME_WS_URL || QWEN_WS_BASE}?model=${encodeURIComponent(data.model)}`

            const upstream = new WebSocket(upstreamUrl, {
                headers: { 'Authorization': `Bearer ${data.apiKey}` }
            } as unknown as string[])

            upstreamMap.set(clientWs, upstream)

            upstream.onopen = () => {
                // Connection ready — upstream will send session.created
            }
            upstream.onmessage = (event) => {
                // Forward upstream → client
                try {
                    if (clientWs.readyState === 1) {
                        clientWs.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
                    }
                } catch { /* client gone */ }
            }
            upstream.onerror = () => {
                try { clientWs.close(1011, 'Upstream error') } catch { /* */ }
            }
            upstream.onclose = (event) => {
                try { clientWs.close(event.code, event.reason) } catch { /* */ }
                upstreamMap.delete(clientWs)
            }
        },
        message(clientWs: ServerWebSocket<unknown>, message: string | ArrayBuffer | Uint8Array) {
            const upstream = upstreamMap.get(clientWs)
            if (upstream?.readyState === WebSocket.OPEN) {
                upstream.send(typeof message === 'string' ? message : message)
            }
        },
        close(clientWs: ServerWebSocket<unknown>, code: number, reason: string) {
            const upstream = upstreamMap.get(clientWs)
            if (upstream) {
                try { upstream.close(code, reason) } catch { /* */ }
                upstreamMap.delete(clientWs)
            }
        }
    }
}
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { Store } from '../store'

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
            'Content-Type': asset.mimeType
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

    app.use('*', logger())

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

    app.use('/assets/*', serveStatic({ root: distDir }))

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir })(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir, path: 'index.html' })(c, next)
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

    // Wrap socket.io websocket handler to also support Qwen Realtime proxy
    const originalWsHandler = socketHandler.websocket
    const qwenProxyHandler = createQwenProxyWebSocketHandler()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (Bun.serve as any)({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: Math.max(socketHandler.maxRequestBodySize, 68 * 1024 * 1024),
        websocket: {
            ...originalWsHandler,
            open(ws: unknown) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean }>
                if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.open(wsAny)
                } else {
                    originalWsHandler.open?.(ws as never)
                }
            },
            message(ws: unknown, message: unknown) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean }>
                if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.message(wsAny, message as string)
                } else {
                    originalWsHandler.message?.(ws as never, message as never)
                }
            },
            close(ws: unknown, code: number, reason: string) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean }>
                if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.close(wsAny, code, reason)
                } else {
                    originalWsHandler.close?.(ws as never, code as never, reason as never)
                }
            }
        },
        fetch: (req: Request, server: { upgrade: (req: Request, opts?: unknown) => boolean }) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server as never)
            }
            // Qwen Realtime WebSocket proxy
            if (url.pathname === '/api/voice/qwen-ws') {
                const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
                const model = url.searchParams.get('model') || 'qwen3.5-omni-plus-realtime'
                if (!apiKey) {
                    return new Response('DashScope API key not configured', { status: 400 })
                }
                const upgraded = server.upgrade(req, {
                    data: { _qwenProxy: true, apiKey, model }
                })
                if (!upgraded) {
                    return new Response('WebSocket upgrade failed', { status: 500 })
                }
                return undefined as unknown as Response
            }
            return app.fetch(req)
        }
    })

    console.log(`[Web] hub listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)

    return server
}

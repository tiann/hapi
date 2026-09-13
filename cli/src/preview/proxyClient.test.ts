import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { once } from 'node:events'

import {
    buildUpstreamRequestPath,
    buildUpstreamWsUrl,
    canRewriteBody,
    parseWsProtocols,
    sanitizeRequestHeaders,
    serveProxyMount
} from './proxyClient'
import type { PreviewOpenFrame } from '@hapi/protocol/preview'
import type { PreviewMount } from './mountManager'
import type { PreviewConnSink } from './tunnelClient'

function frame(overrides: Partial<PreviewOpenFrame> = {}): PreviewOpenFrame {
    return {
        type: 'open',
        connId: 'c1',
        mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
        kind: 'http',
        method: 'GET',
        path: '',
        headers: {},
        ...overrides
    }
}

describe('buildUpstreamRequestPath / buildUpstreamWsUrl', () => {
    it('never lets a leading // replace the approved loopback authority', () => {
        const target = new URL('http://127.0.0.1:5173')

        const wsUrl = buildUpstreamWsUrl(target, '/192.168.1.10:8080/ws')
        expect(wsUrl.hostname).toBe('127.0.0.1')
        expect(wsUrl.port).toBe('5173')
        expect(wsUrl.pathname).toBe('/192.168.1.10:8080/ws')
        expect(wsUrl.protocol).toBe('ws:')

        expect(buildUpstreamRequestPath('//192.168.1.10:8080/ws')).toBe('/192.168.1.10:8080/ws')
        expect(buildUpstreamRequestPath('assets/app.js', 'v=2')).toBe('/assets/app.js?v=2')
    })

    it('keeps the query and forces ws/wss from the target scheme', () => {
        const wsUrl = buildUpstreamWsUrl(new URL('https://localhost:5173'), 'hmr', 'token=1')
        expect(wsUrl.toString()).toBe('wss://localhost:5173/hmr?token=1')
    })
})

describe('parseWsProtocols', () => {
    it('splits the raw Sec-WebSocket-Protocol header', () => {
        expect(parseWsProtocols('vite-hmr, v2.chat')).toEqual(['vite-hmr', 'v2.chat'])
        expect(parseWsProtocols(undefined)).toEqual([])
        expect(parseWsProtocols('')).toEqual([])
    })
})

describe('canRewriteBody', () => {
    it('rewrites only uncompressed HTML', () => {
        expect(canRewriteBody('text/html; charset=utf-8', undefined)).toBe(true)
        expect(canRewriteBody('text/html', 'identity')).toBe(true)
        expect(canRewriteBody('text/html', 'br')).toBe(false)
        expect(canRewriteBody('text/html', 'gzip')).toBe(false)
        expect(canRewriteBody('application/json', undefined)).toBe(false)
    })
})

describe('sanitizeRequestHeaders', () => {
    it('requests identity encoding so HTML rewriting sees plain bytes', () => {
        const target = new URL('http://127.0.0.1:5173')
        const headers = sanitizeRequestHeaders(frame({ headers: { 'accept-encoding': 'gzip, br' } }), target)
        expect(headers['accept-encoding']).toBe('identity')
        expect(headers.host).toBe('127.0.0.1:5173')
    })
})

describe('serveProxyMount backpressure', () => {
    it('honors pause/resume from the hub on the upstream response', async () => {
        const upstream = createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' })
            const timer = setInterval(() => {
                if (res.writableEnded || res.destroyed) {
                    clearInterval(timer)
                    return
                }
                res.write(Buffer.alloc(64 * 1024, 1))
            }, 2)
            res.on('close', () => clearInterval(timer))
        })
        upstream.listen(0, '127.0.0.1')
        await once(upstream, 'listening')
        const port = (upstream.address() as { port: number }).port

        const mount: PreviewMount = {
            mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
            kind: 'proxy',
            name: 'dev',
            port,
            ws: true,
            publicUrl: 'http://hub/preview/5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b/',
            expiresAt: Date.now() + 3600_000,
            createdAt: Date.now()
        }
        let received = 0
        const sink: PreviewConnSink = {
            respond() {},
            data(payload) {
                received += payload.byteLength
            },
            end() {},
            error() {},
            wsMessage() {},
            wsClose() {},
            close() {}
        }

        const handlers = serveProxyMount(mount, frame({ path: 'stream' }), sink)
        // Let some data flow, then pause and verify the upstream actually stops.
        await new Promise((resolve) => setTimeout(resolve, 120))
        const atPause = received
        expect(atPause).toBeGreaterThan(0)

        handlers.onFlow?.('pause')
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(received).toBe(atPause)

        handlers.onFlow?.('resume')
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(received).toBeGreaterThan(atPause)

        handlers.onClose?.()
        ;(upstream as Server).close()
    }, 10_000)
})

describe('serveProxyMount WS handshake queue', () => {
    it('bounds browser bytes queued while the upstream handshake stalls', async () => {
        // Accepts TCP but never speaks — the ws client handshake stays pending
        // for the full handshake timeout, like a wedged dev server.
        const stalled = createNetServer(() => {})
        stalled.listen(0, '127.0.0.1')
        await once(stalled, 'listening')
        const port = (stalled.address() as { port: number }).port

        const mount: PreviewMount = {
            mountId: '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
            kind: 'proxy',
            name: 'dev',
            port,
            ws: true,
            publicUrl: 'http://hub/preview/5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b/',
            expiresAt: Date.now() + 3600_000,
            createdAt: Date.now()
        }
        const closes: Array<{ code: number; reason?: string }> = []
        const sink: PreviewConnSink = {
            respond() {},
            data() {},
            end() {},
            error() {},
            wsMessage() {},
            wsClose(code, reason) {
                closes.push({ code, reason })
            },
            close() {}
        }

        const handlers = serveProxyMount(mount, frame({ kind: 'ws', path: 'ws' }), sink)
        // 20 × 64 KiB of individually valid messages > the 1 MiB queue budget.
        for (let i = 0; i < 20; i++) {
            handlers.onWsMessage?.(true, 'x'.repeat(64 * 1024))
        }

        expect(closes.some((c) => c.code === 1009)).toBe(true)
        handlers.onClose?.()
        stalled.close()
    })
})

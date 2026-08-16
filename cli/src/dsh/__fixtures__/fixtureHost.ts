import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ClientRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'

/**
 * Deterministic DSH host fixture for unit tests: a real loopback HTTP + WS
 * server that speaks the official apiproxy wire envelope (same schemas the
 * production transport parses). No DSH runtime or model API required.
 */

export type FixtureHost = {
    baseUrl: string
    port: number
    /** Handlers per endpoint; a missing handler answers rpc-not-found. */
    onRequest: (endpoint: string, payload: unknown) => Promise<unknown> | unknown
    /** Push one mux frame to all connected mux sockets. */
    pushMux(frame: MuxFrame): void
    /** Push one host frame to all connected host sockets. */
    pushHost(frame: HostFrame): void
    /** Last N client requests received, for assertions. */
    requests: Array<{ endpoint: string; payload: unknown }>
    /** Pending rpcIds of unanswered approval/question server-requests. */
    pendingServerRequests: Map<string, ServerRequest>
    close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => resolve(data))
        req.on('error', reject)
    })
}

function sendJson(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}

export function createFixtureHost(): Promise<FixtureHost> {
    const host: FixtureHost = {
        baseUrl: 'http://127.0.0.1:0',
        port: 0,
        onRequest: (endpoint) => {
            // Backfill (initial + reconnect) probes session history; an empty
            // page keeps the bridge moving without inventing events.
            if (endpoint === 'session.history') {
                return { ok: true, value: { events: [], hasMore: false } }
            }
            return { ok: true, value: {} }
        },
        pushMux: () => {},
        pushHost: () => {},
        requests: [],
        pendingServerRequests: new Map(),
        close: async () => {}
    }

    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            if (req.method !== 'POST' || req.url === undefined || !req.url.startsWith('/api/')) {
                sendJson(res, { error: 'not found' })
                return
            }
            const endpoint = req.url.slice('/api/'.length)
            const body = await readBody(req)
            let message: ClientRequest
            try {
                const parsed = JSON.parse(body)
                // The official client envelope schema validates; accept both
                // 'client-request' and legacy 'request' shapes for robustness.
                if (parsed.type === 'client-request' || parsed.type === 'request') {
                    message = parsed as ClientRequest
                } else {
                    sendJson(res, { type: 'server-response', rpcId: 'unknown', result: { ok: false, error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } } } })
                    return
                }
            } catch {
                sendJson(res, { type: 'server-response', rpcId: 'unknown', result: { ok: false, error: { code: 'bad-request', message: 'body is not JSON', details: { issues: [] } } } })
                return
            }

            host.requests.push({ endpoint, payload: message.payload })
            let result: unknown
            try {
                result = await host.onRequest(endpoint, message.payload)
            } catch (error) {
                result = {
                    ok: false,
                    error: {
                        code: 'internal',
                        message: error instanceof Error ? error.message : String(error),
                        details: {}
                    }
                }
            }
            const response = serverResponseSchema.parse({
                type: 'server-response',
                rpcId: message.rpcId,
                result
            })
            sendJson(res, response)
        })

        const wss = new WebSocketServer({ noServer: true })
        const muxSockets = new Set<WebSocket>()
        const hostSockets = new Set<WebSocket>()
        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url ?? '/', 'http://dsh.test')
            if (url.pathname === '/api/events.mux') {
                wss.handleUpgrade(req, socket, head, (ws) => {
                    muxSockets.add(ws)
                    ws.on('close', () => muxSockets.delete(ws))
                })
                return
            }
            if (url.pathname === '/api/events.host') {
                wss.handleUpgrade(req, socket, head, (ws) => {
                    hostSockets.add(ws)
                    ws.on('close', () => hostSockets.delete(ws))
                })
                return
            }
            socket.destroy()
        })

        const pushTo = (sockets: Set<WebSocket>, frame: MuxFrame | HostFrame, method: string) => {
            const envelope: ServerRequest = {
                type: 'server-request',
                rpcId: RpcId(`fixture-${Math.random().toString(36).slice(2)}`),
                method,
                payload: frame
            }
            const text = JSON.stringify(envelope)
            for (const ws of sockets) {
                ws.send(text)
            }
        }
        host.pushMux = (frame) => pushTo(muxSockets, frame, 'session/event')
        host.pushHost = (frame) => pushTo(hostSockets, frame, 'host/event')

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo
            host.baseUrl = `http://127.0.0.1:${port}`
            host.port = port
            host.close = async () => {
                for (const ws of muxSockets) {
                    ws.close()
                }
                for (const ws of hostSockets) {
                    ws.close()
                }
                await new Promise<void>((resolveClose) => {
                    server.close(() => resolveClose())
                    wss.close()
                })
            }
            resolve(host)
        })
        server.on('error', reject)
    })
}

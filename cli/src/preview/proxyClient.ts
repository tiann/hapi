import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { WebSocket } from 'ws'

import {
    PREVIEW_IDLE_TIMEOUT_MS,
    PREVIEW_OPEN_TIMEOUT_MS,
    stripHopByHopHeaders,
    type PreviewOpenFrame,
    type PreviewResponseHeaders
} from '@hapi/protocol/preview'

import { logger } from '@/ui/logger'

import { isHtmlContentType } from './mime'
import { rewriteHtml, rewriteLocation, rewriteSetCookie } from './rewrite'
import type { PreviewConnHandlers, PreviewConnSink } from './tunnelClient'
import type { PreviewMount } from './mountManager'

/**
 * Proxy mount terminator: bridges one virtual tunnel conn to a loopback dev
 * server. HTTP requests go through node:http(s); WebSocket upgrades bridge to
 * a `ws` client (HMR pass-through). HTML responses get best-effort sub-path
 * rewriting (attributes + <base>), Location and Set-Cookie are rewritten too.
 */

const HTML_REWRITE_LIMIT = 2 * 1024 * 1024
const WS_MAX_PAYLOAD = 64 * 1024 * 1024

/** Upstreams only ever speak to loopback; enforced at mount + serve time. */
function resolveTarget(mount: PreviewMount): URL {
    const raw = mount.port !== undefined ? `http://127.0.0.1:${mount.port}` : mount.url
    if (!raw) throw new Error('proxy mount has no target')
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('proxy target must be http(s)')
    }
    return url
}

function upstreamRequest(target: URL, options: RequestOptions) {
    return target.protocol === 'https:' ? httpsRequest(target, options) : httpRequest(target, options)
}

/**
 * Builds the upstream request path. Browser input is NEVER resolved as a URL
 * against the target: a leading `//` would be protocol-relative and replace
 * the approved loopback authority. Leading slashes are stripped and the result
 * is assigned as a plain path string.
 */
export function buildUpstreamRequestPath(path: string, query?: string): string {
    const clean = path.replace(/^\/+/, '')
    return `/${clean}${query ? `?${query}` : ''}`
}

/** Same rule for WebSocket URLs — assign pathname on a copy of the target. */
export function buildUpstreamWsUrl(target: URL, path: string, query?: string): URL {
    const wsUrl = new URL(target)
    wsUrl.pathname = `/${path.replace(/^\/+/, '')}`
    wsUrl.search = query ?? ''
    wsUrl.hash = ''
    wsUrl.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    return wsUrl
}

/** Parses a raw `sec-websocket-protocol` header into the ws client's protocols arg. */
export function parseWsProtocols(header: string | undefined): string[] {
    return (header ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
}

/**
 * True when the response body is safe to buffer-and-rewrite as UTF-8 text.
 * Compressed bodies (gzip/br/...) are opaque bytes — decoding them as UTF-8
 * would corrupt them — so they always take the pass-through branch.
 */
export function canRewriteBody(contentType: string | undefined, contentEncoding: string | undefined): boolean {
    if (!isHtmlContentType(contentType)) return false
    const encoding = (contentEncoding ?? 'identity').toLowerCase()
    return encoding === 'identity' || encoding === ''
}

/** Request headers: hop-by-hop + identity headers dropped, host set to target. */
export function sanitizeRequestHeaders(frame: PreviewOpenFrame, target: URL): Record<string, string> {
    const headers = stripHopByHopHeaders(frame.headers)
    for (const name of ['host', 'content-length', 'origin', 'referer']) {
        delete headers[name]
    }
    for (const name of Object.keys(headers)) {
        if (name.startsWith('sec-websocket-')) delete headers[name]
    }
    headers.host = target.host
    // node:http does not decompress; HTML rewriting needs plain bytes.
    headers['accept-encoding'] = 'identity'
    if (frame.body !== undefined && frame.body.byteLength > 0) {
        headers['content-length'] = String(frame.body.byteLength)
    }
    return headers
}

/** Response headers: hop-by-hop dropped, Location/Set-Cookie rewritten. */
function sanitizeResponseHeaders(rawHeaders: Record<string, string | string[] | undefined>, prefix: string): PreviewResponseHeaders {
    const flat: Record<string, string> = {}
    for (const [name, value] of Object.entries(rawHeaders)) {
        if (value === undefined) continue
        flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    }
    const headers = stripHopByHopHeaders(flat) as PreviewResponseHeaders
    delete headers['keep-alive']
    if (typeof headers['location'] === 'string') {
        headers['location'] = rewriteLocation(headers['location'], prefix)
    }
    // set-cookie needs per-cookie handling → rebuilt below from rawHeaders.
    delete headers['set-cookie']
    const setCookie = rawHeaders['set-cookie']
    if (Array.isArray(setCookie) && setCookie.length > 0) {
        headers['set-cookie'] = setCookie.map((cookie) => rewriteSetCookie(cookie, prefix))
    }
    return headers
}

function serveProxyHttp(mount: PreviewMount, frame: PreviewOpenFrame, sink: PreviewConnSink, target: URL, prefix: string): PreviewConnHandlers {
    const handlers: PreviewConnHandlers = {}
    const method = (frame.method ?? 'GET').toUpperCase()
    let upstream: ReturnType<typeof upstreamRequest>
    let responded = false
    let done = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
            logger.debug('[preview] Proxy conn idle timeout')
            terminate(504, 'Gateway Timeout')
        }, PREVIEW_IDLE_TIMEOUT_MS)
        idleTimer.unref?.()
    }

    const terminate = (status: number | undefined, message: string): void => {
        if (done) return
        done = true
        if (idleTimer) clearTimeout(idleTimer)
        if (!responded) {
            sink.error(status ?? 502, message)
        } else {
            sink.close()
        }
        upstream?.destroy()
    }

    try {
        const headers = sanitizeRequestHeaders(frame, target)
        upstream = upstreamRequest(target, { method, headers, path: buildUpstreamRequestPath(frame.path, frame.query) })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sink.error(502, `Bad gateway: ${message}`)
        return handlers
    }

    upstream.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error)
        // Dev server not up yet / wrong port — the classic 502 case.
        void (error as NodeJS.ErrnoException).code
        terminate(502, `Bad gateway: ${message}`)
    })

    upstream.on('response', (res) => {
        if (done) return
        armIdle()
        const status = res.statusCode ?? 502
        const headers = sanitizeResponseHeaders(res.headers, prefix)
        // Encoded bodies are opaque bytes — never decode-and-rewrite them.
        if (!canRewriteBody(res.headers['content-type'], res.headers['content-encoding'])) {
            responded = true
            sink.respond({ status, headers })
            res.on('data', (chunk: Buffer) => {
                armIdle()
                sink.data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
            })
            res.on('end', () => {
                done = true
                if (idleTimer) clearTimeout(idleTimer)
                sink.end()
            })
            res.on('error', () => terminate(undefined, 'upstream response failed'))
            return
        }

        // HTML: buffer (bounded), rewrite, then forward as one body. Oversized
        // documents fall back to pass-through from the buffer onward.
        const chunks: Buffer[] = []
        let buffered = 0
        let overflow = false
        res.on('data', (chunk: Buffer) => {
            armIdle()
            if (overflow) {
                sink.data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
                return
            }
            buffered += chunk.byteLength
            if (buffered > HTML_REWRITE_LIMIT) {
                overflow = true
                responded = true
                sink.respond({ status, headers })
                for (const pending of chunks) {
                    sink.data(new Uint8Array(pending.buffer, pending.byteOffset, pending.byteLength))
                }
                chunks.length = 0
                sink.data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
                return
            }
            chunks.push(chunk)
        })
        res.on('end', () => {
            done = true
            if (idleTimer) clearTimeout(idleTimer)
            if (!overflow) {
                const html = Buffer.concat(chunks).toString('utf8')
                const rewritten = rewriteHtml(html, prefix)
                const body = Buffer.from(rewritten, 'utf8')
                const finalHeaders = { ...headers, 'content-length': String(body.byteLength) }
                responded = true
                sink.respond({ status, headers: finalHeaders })
                sink.data(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
            }
            sink.end()
        })
        res.on('error', () => terminate(undefined, 'upstream response failed'))
    })

    if (frame.body !== undefined && frame.body.byteLength > 0) {
        upstream.write(frame.body)
    }
    upstream.end()
    armIdle()

    return {
        onData(payload) {
            armIdle()
            upstream.write(payload)
        },
        onClose() {
            terminate(undefined, 'browser aborted')
        }
    }
}

function serveProxyWs(mount: PreviewMount, frame: PreviewOpenFrame, sink: PreviewConnSink, target: URL): PreviewConnHandlers {
    const wsUrl = buildUpstreamWsUrl(target, frame.path, frame.query)
    const protocols = parseWsProtocols(frame.protocols)
    let ws: WebSocket
    let closed = false
    let upstreamOpen = false
    // Browsers (vite HMR) send the first app frame immediately after the
    // upgrade; the upstream client may still be CONNECTING — buffer until open.
    const pendingOutbound: Array<{ payload: string | Uint8Array; isText: boolean }> = []
    try {
        ws = new WebSocket(wsUrl, protocols, {
            perMessageDeflate: false,
            maxPayload: WS_MAX_PAYLOAD,
            handshakeTimeout: PREVIEW_OPEN_TIMEOUT_MS
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sink.wsClose(1011, message)
        return {}
    }

    ws.on('open', () => {
        upstreamOpen = true
        for (const { payload, isText } of pendingOutbound.splice(0)) {
            ws.send(payload, { binary: !isText })
        }
    })
    ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (closed) return
        sink.wsMessage(isBinary, isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'))
    })
    ws.on('close', (code, reason) => {
        closed = true
        sink.wsClose(code, reason?.toString('utf8') || undefined)
    })
    ws.on('error', (error) => {
        logger.debug('[preview] WS upstream error:', error instanceof Error ? error.message : String(error))
        if (!closed) {
            closed = true
            sink.wsClose(1011, 'upstream websocket error')
        }
    })

    return {
        onWsMessage(isText, payload) {
            if (closed) return
            if (!upstreamOpen) {
                pendingOutbound.push({ payload, isText })
                return
            }
            ws.send(payload, { binary: !isText })
        },
        onWsClose(code, reason) {
            if (closed) return
            closed = true
            ws.close(code === 0 ? 1000 : code, reason)
        },
        onClose() {
            if (closed) return
            closed = true
            ws.terminate()
        }
    }
}

export function serveProxyMount(mount: PreviewMount, frame: PreviewOpenFrame, sink: PreviewConnSink): PreviewConnHandlers {
    let target: URL
    try {
        target = resolveTarget(mount)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sink.error(502, `Bad gateway: ${message}`)
        return {}
    }
    if (frame.kind === 'ws') {
        return serveProxyWs(mount, frame, sink, target)
    }
    return serveProxyHttp(mount, frame, sink, target, `/preview/${mount.mountId}`)
}

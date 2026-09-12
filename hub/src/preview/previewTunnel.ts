import { randomUUID } from 'node:crypto'
import type { Namespace } from 'socket.io'

import {
    PREVIEW_CONNS_PER_MOUNT,
    PREVIEW_HUB_TOTAL_CONNS,
    PREVIEW_MAX_RESPONSE_BUFFER_BYTES,
    PREVIEW_OPEN_TIMEOUT_MS,
    PREVIEW_RESUME_BUFFER_BYTES,
    type PreviewFrame,
    type PreviewOpenFrame,
    type PreviewResponseHeaders
} from '@hapi/protocol/preview'

import type { PreviewMountEntry } from './previewRegistry'

/** The typed `/cli` namespace the tunnel emits frames on. */
export type CliPreviewNamespace = Namespace<
    import('@hapi/protocol').ServerToClientEvents,
    import('@hapi/protocol').ClientToServerEvents,
    import('socket.io').DefaultEventsMap,
    import('../socket/socketTypes').SocketData
>

/**
 * Hub side of the preview tunnel: opens one virtual conn per browser request /
 * WebSocket upgrade, exchanges frames with the CLI over the `/cli` socket.io
 * namespace, and exposes HTTP conns as a promise + ReadableStream for the
 * `/preview/*` routes. Frames are fire-and-forget; flow control uses
 * pause/resume with a hard per-conn buffer cap. Data-plane code stays silent —
 * failures surface as 404/502/504 responses to the browser.
 */

export interface PreviewRequestMeta {
    method: string
    /** Raw (still percent-encoded) sub-path below the mount. */
    path: string
    query: string | undefined
    /** Lowercase, hop-by-hop-stripped browser request headers. */
    headers: Record<string, string>
    body: Uint8Array | undefined
    /** Raw `sec-websocket-protocol` header for ws upgrades. */
    protocols: string | undefined
}

export interface PreviewHttpConn {
    /** Resolves with the CLI's head, or null if the conn died before one. */
    head: Promise<{ status: number; headers: PreviewResponseHeaders } | null>
    body: ReadableStream<Uint8Array>
    close(): void
}

export interface PreviewWsConn {
    send(payload: string | Uint8Array, isText: boolean): void
    close(code?: number, reason?: string): void
    onMessage(callback: (payload: string | Uint8Array, isText: boolean) => void): void
    onClose(callback: (code: number, reason?: string) => void): void
}

interface ConnState {
    connId: string
    mountId: string
    socketId: string
    kind: 'http' | 'ws'
    headResolve: ((head: { status: number; headers: PreviewResponseHeaders } | null) => void) | null
    controller: ReadableStreamDefaultController<Uint8Array> | null
    buffered: number
    pausedSent: boolean
    resumedSent: boolean
    closed: boolean
    wsMessage: ((payload: string | Uint8Array, isText: boolean) => void) | null
    wsClose: ((code: number, reason?: string) => void) | null
    openTimer: ReturnType<typeof setTimeout> | null
}

export class PreviewTunnel {
    private readonly conns = new Map<string, ConnState>()

    constructor(private readonly cliNamespace: CliPreviewNamespace) {}

    /** CLI told us something: route it (socketId scoping prevents cross-talk). */
    handleFrame(socketId: string, raw: unknown): void {
        const frame = raw as Partial<PreviewFrame>
        if (!frame || typeof frame !== 'object' || typeof frame.connId !== 'string') return
        const conn = this.conns.get(frame.connId)
        if (!conn || conn.socketId !== socketId || conn.closed) return

        switch (frame.type) {
            case 'response':
                if (conn.headResolve) {
                    conn.headResolve({ status: frame.status ?? 502, headers: frame.headers ?? {} })
                    conn.headResolve = null
                }
                break
            case 'data':
                this.enqueue(conn, frame.payload as Uint8Array)
                break
            case 'end':
                this.finishConn(conn)
                break
            case 'error': {
                const status = frame.status ?? 502
                const message = frame.message ?? 'Preview conn failed'
                if (conn.headResolve) {
                    conn.headResolve({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
                    conn.headResolve = null
                    this.enqueue(conn, new TextEncoder().encode(message))
                }
                this.finishConn(conn)
                break
            }
            case 'ws-message':
                conn.wsMessage?.(frame.payload as string | Uint8Array, frame.isText === true)
                break
            case 'ws-close':
                this.finishConn(conn)
                conn.wsClose?.(frame.code ?? 1005, frame.reason)
                break
            case 'close':
                this.finishConn(conn)
                break
            default:
                // 'open' / 'pause' / 'resume' never arrive from the CLI.
                break
        }
    }

    openHttp(entry: PreviewMountEntry, meta: PreviewRequestMeta): PreviewHttpConn | null {
        const conn = this.createConn(entry, 'http')
        if (!conn) return null

        const body = new ReadableStream<Uint8Array>({
            start: (controller) => {
                conn.controller = controller
            },
            cancel: () => {
                // Browser aborted the response.
                this.closeConn(conn)
            }
        })

        const head = new Promise<{ status: number; headers: PreviewResponseHeaders } | null>((resolve) => {
            conn.headResolve = resolve
        })

        this.armOpenTimer(conn)
        this.emitOpen(conn, meta)

        return {
            head,
            body,
            close: () => this.closeConn(conn)
        }
    }

    openWs(entry: PreviewMountEntry, meta: PreviewRequestMeta): PreviewWsConn | null {
        const conn = this.createConn(entry, 'ws')
        if (!conn) return null

        this.armOpenTimer(conn)
        this.emitOpen(conn, meta)

        return {
            send: (payload, isText) => {
                if (conn.closed) return
                this.emit(conn.socketId, { type: 'ws-message', connId: conn.connId, isText, payload })
            },
            close: (code, reason) => {
                if (conn.closed) return
                this.emit(conn.socketId, { type: 'ws-close', connId: conn.connId, code: code ?? 1000, reason })
                this.finishConn(conn)
            },
            onMessage: (callback) => {
                conn.wsMessage = callback
            },
            onClose: (callback) => {
                conn.wsClose = callback
            }
        }
    }

    /** CLI socket gone: fail every conn that rode on it. */
    detachSocket(socketId: string): void {
        for (const conn of [...this.conns.values()]) {
            if (conn.socketId !== socketId) continue
            this.failHead(conn, null)
            this.finishConn(conn)
        }
    }

    get stats(): { conns: number } {
        return { conns: this.conns.size }
    }

    private connCountForMount(mountId: string): number {
        let count = 0
        for (const conn of this.conns.values()) {
            if (conn.mountId === mountId) count += 1
        }
        return count
    }

    private createConn(entry: PreviewMountEntry, kind: 'http' | 'ws'): ConnState | null {
        if (this.conns.size >= PREVIEW_HUB_TOTAL_CONNS) return null
        if (this.connCountForMount(entry.mountId) >= PREVIEW_CONNS_PER_MOUNT) return null
        const conn: ConnState = {
            connId: randomUUID(),
            mountId: entry.mountId,
            socketId: entry.socketId,
            kind,
            headResolve: null,
            controller: null,
            buffered: 0,
            pausedSent: false,
            resumedSent: true,
            closed: false,
            wsMessage: null,
            wsClose: null,
            openTimer: null
        }
        this.conns.set(conn.connId, conn)
        return conn
    }

    private armOpenTimer(conn: ConnState): void {
        // Head deadline: if the CLI never answers, the browser gets a 504
        // instead of hanging on a dead socket.
        conn.openTimer = setTimeout(() => {
            if (conn.closed) return
            this.failHead(conn, null)
            this.finishConn(conn)
        }, PREVIEW_OPEN_TIMEOUT_MS)
        conn.openTimer.unref?.()
    }

    private emitOpen(conn: ConnState, meta: PreviewRequestMeta): void {
        const open: PreviewOpenFrame = {
            type: 'open',
            connId: conn.connId,
            mountId: conn.mountId,
            kind: conn.kind,
            path: meta.path,
            headers: meta.headers
        }
        if (meta.method) open.method = meta.method
        if (meta.query !== undefined) open.query = meta.query
        if (meta.body !== undefined && meta.body.byteLength > 0) open.body = meta.body
        if (meta.protocols !== undefined && meta.protocols.length > 0) open.protocols = meta.protocols

        this.emit(conn.socketId, open)
    }

    private emit(socketId: string, frame: PreviewFrame): boolean {
        const socket = this.cliNamespace.sockets.get(socketId)
        if (!socket) return false
        socket.emit('preview:frame', frame)
        return true
    }

    private enqueue(conn: ConnState, payload: Uint8Array): void {
        if (conn.closed || !conn.controller) return
        try {
            conn.controller.enqueue(payload)
            conn.buffered += payload.byteLength
            if (conn.buffered >= PREVIEW_MAX_RESPONSE_BUFFER_BYTES && !conn.pausedSent) {
                conn.pausedSent = true
                conn.resumedSent = false
                this.emit(conn.socketId, { type: 'pause', connId: conn.connId })
            } else if (conn.buffered <= PREVIEW_RESUME_BUFFER_BYTES && conn.pausedSent && !conn.resumedSent) {
                conn.resumedSent = true
                conn.pausedSent = false
                this.emit(conn.socketId, { type: 'resume', connId: conn.connId })
            }
        } catch {
            // Stream already closed by the consumer.
            this.closeConn(conn)
        }
    }

    private failHead(conn: ConnState, head: { status: number; headers: PreviewResponseHeaders } | null): void {
        if (conn.headResolve) {
            conn.headResolve(head)
            conn.headResolve = null
        }
    }

    private closeConn(conn: ConnState): void {
        if (conn.closed) return
        this.emit(conn.socketId, { type: 'close', connId: conn.connId })
        this.finishConn(conn)
    }

    private finishConn(conn: ConnState): void {
        if (conn.closed) return
        conn.closed = true
        if (conn.openTimer) {
            clearTimeout(conn.openTimer)
            conn.openTimer = null
        }
        this.failHead(conn, null)
        try {
            conn.controller?.close()
        } catch {
            // Already closed.
        }
        this.conns.delete(conn.connId)
    }
}

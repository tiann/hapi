import { logger } from '@/ui/logger'
import {
    PREVIEW_FRAME_PAYLOAD_BYTES,
    PreviewFrameSchema,
    type PreviewBytes,
    type PreviewFrame,
    type PreviewOpenFrame,
    type PreviewResponseHeaders
} from '@hapi/protocol/preview'

/**
 * CLI side of the preview tunnel. Validates inbound `preview:frame` events and
 * routes them to per-conn terminators; every outbound frame goes straight onto
 * the session socket (never through the chat queue, so a large transfer cannot
 * stall interactive traffic).
 */

/** What a terminator (static/proxy) uses to answer one virtual conn. */
export interface PreviewConnSink {
    /** HTTP head. Exactly once per http conn, before any data. */
    respond(response: { status: number; headers: PreviewResponseHeaders }): void
    /** HTTP body chunk; split into ≤256 KiB frames internally. */
    data(payload: PreviewBytes): void
    /** HTTP body complete. */
    end(): void
    /** Terminal error; the hub turns it into an HTTP error response. */
    error(status: number | undefined, message: string): void
    /** WebSocket app frame toward the browser. */
    wsMessage(isText: boolean, payload: string | PreviewBytes): void
    /** WebSocket close toward the browser. */
    wsClose(code: number, reason?: string): void
    /** Abort/close the conn from the CLI side. Idempotent. */
    close(): void
}

/** Handler callbacks the terminator registers when it accepts an `open`. */
export interface PreviewConnHandlers {
    /** Browser request body chunk (http kind only). */
    onData?(payload: PreviewBytes): void
    /** Browser WebSocket frame (ws kind only). */
    onWsMessage?(isText: boolean, payload: string | PreviewBytes): void
    /** Browser WebSocket closed. */
    onWsClose?(code: number, reason?: string): void
    /** Hub flow control on the response direction. */
    onFlow?(action: 'pause' | 'resume'): void
    /** Hub aborted/closed the conn (browser abort, hub shutdown, TTL). */
    onClose?(): void
}

export type PreviewTerminator = (frame: PreviewOpenFrame, sink: PreviewConnSink) => PreviewConnHandlers | void

/** Narrow socket surface the runtime needs — implemented by ApiSessionClient. */
export interface PreviewSocketAdapter {
    connected(): boolean
    emitFrame(frame: PreviewFrame): boolean
}

interface ConnState {
    handlers: PreviewConnHandlers
    seq: number
    closed: boolean
    responded: boolean
}

export class PreviewTunnel {
    private readonly conns = new Map<string, ConnState>()

    constructor(private readonly socket: PreviewSocketAdapter) {}

    handleFrame(raw: unknown): void {
        const parsed = PreviewFrameSchema.safeParse(raw)
        if (!parsed.success) {
            logger.debug('[preview] Dropping malformed tunnel frame')
            return
        }
        const frame = parsed.data
        if (frame.type === 'open') {
            // Dispatch happens in the runtime, which owns the mount table.
            return
        }
        const conn = this.conns.get(frame.connId)
        if (!conn) {
            // Late frames after we closed the conn race across one RTT — ignore.
            if (frame.type !== 'close') {
                this.socket.emitFrame({ type: 'close', connId: frame.connId })
            }
            return
        }
        switch (frame.type) {
            case 'data':
                conn.handlers.onData?.(frame.payload)
                break
            case 'ws-message':
                conn.handlers.onWsMessage?.(frame.isText, frame.payload)
                break
            case 'ws-close':
                conn.handlers.onWsClose?.(frame.code, frame.reason)
                this.dropConn(frame.connId)
                break
            case 'pause':
            case 'resume':
                conn.handlers.onFlow?.(frame.type)
                break
            case 'close':
                conn.handlers.onClose?.()
                this.dropConn(frame.connId)
                break
            case 'response':
            case 'end':
            case 'error':
                // Hub never sends these to the CLI.
                break
        }
    }

    /**
     * Routes an `open` to the mount's terminator and tracks the new conn.
     * Returns false when the mount has no terminator (unknown mount — the
     * runtime closes the conn) or the socket is gone.
     */
    acceptOpen(frame: PreviewOpenFrame, terminator: PreviewTerminator): void {
        const conn: ConnState = { handlers: {}, seq: 0, closed: false, responded: false }
        this.conns.set(frame.connId, conn)
        const sink = this.createSink(frame.connId, conn)
        try {
            const handlers = terminator(frame, sink)
            if (handlers) conn.handlers = handlers
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger.debug('[preview] Terminator failed to accept conn:', message)
            sink.error(500, 'Preview terminator failed')
        }
    }

    /** Unknown/expired mount: tell the hub to fail the conn fast. */
    rejectOpen(connId: string): void {
        if (this.conns.has(connId)) return
        this.socket.emitFrame({ type: 'close', connId })
    }

    /** Socket dropped: fail every live conn fast. Mounts stay registered. */
    failAll(reason: string): void {
        for (const [connId, conn] of this.conns) {
            conn.handlers.onClose?.()
            this.dropConn(connId)
        }
        if (this.conns.size > 0) {
            logger.debug(`[preview] Failed ${this.conns.size} conns: ${reason}`)
        }
    }

    get connCount(): number {
        return this.conns.size
    }

    private dropConn(connId: string): void {
        this.conns.delete(connId)
    }

    private createSink(connId: string, conn: ConnState): PreviewConnSink {
        const rawSend = (frame: PreviewFrame): boolean => this.socket.connected() && this.socket.emitFrame(frame)
        const finish = (): void => {
            conn.closed = true
            this.dropConn(connId)
        }
        const send = (frame: PreviewFrame): boolean => {
            if (conn.closed) return false
            if (!rawSend(frame)) {
                finish()
                return false
            }
            return true
        }
        return {
            respond(response) {
                if (conn.responded) return
                conn.responded = true
                send({ type: 'response', connId, status: response.status, headers: response.headers })
            },
            data(payload) {
                let offset = 0
                while (offset < payload.byteLength) {
                    const chunk = payload.subarray(offset, offset + PREVIEW_FRAME_PAYLOAD_BYTES)
                    offset += chunk.byteLength
                    if (!send({ type: 'data', connId, seq: conn.seq, payload: chunk })) return
                    conn.seq += 1
                }
            },
            // `end`/`error` are terminal in themselves — the hub needs no close.
            end() {
                send({ type: 'end', connId })
                finish()
            },
            error(status, message) {
                send({ type: 'error', connId, status, message })
                finish()
            },
            wsMessage(isText, payload) {
                send({ type: 'ws-message', connId, isText, payload })
            },
            wsClose(code, reason) {
                send({ type: 'ws-close', connId, code, reason })
                finish()
            },
            close() {
                send({ type: 'close', connId })
                finish()
            }
        }
    }
}

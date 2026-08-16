import { AbstractApiClient, type IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { muxFrameSchema, hostFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ApiProxy, HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcId as DshRpcId, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

/**
 * Official event-stream WebSocket pathnames (owned by
 * `@deepseek-ai/dsh-client-connection`; inlined here to avoid importing that
 * package's browser-bundle entry from Node).
 */
const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'

/**
 * Node/Bun transport for the official DSH apiproxy contract.
 *
 * The official browser client (`WebApiClient` in `dsh-client-connection`)
 * subclasses the same `AbstractApiClient` with fetch + WebSocket; this class
 * is the Node equivalent — same envelope semantics, same wire paths, same
 * frame schemas — so HAPI speaks exactly the protocol the official Web UI
 * uses, without any browser bundle or frontend.
 */
export class DshNodeTransport extends AbstractApiClient {
    constructor(private readonly baseUrl: string) {
        super()
    }

    /** Real loopback authority instead of the browser/no-location fallback. */
    protected override resolveBase(): string {
        return this.baseUrl
    }

    protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
        return fetch(input, init)
    }

    /** rpcIds reserved by callers BEFORE the unary call (prompt identity):
     *  mintRpcId drains this queue first, so the wire rpcId is known to the
     *  caller before the request leaves — even if the host's user/message
     *  event beats the HTTP response back. */
    private reservedRpcIds: DshRpcId[] = []

    reserveRpcId(): DshRpcId {
        const id = crypto.randomUUID() as DshRpcId
        this.reservedRpcIds.push(id)
        return id
    }

    /** Structural alias for consumers that hold the client as the base type. */
    __reserveRpcId(): string {
        return this.reserveRpcId()
    }

    protected override mintRpcId(): DshRpcId {
        const reserved = this.reservedRpcIds.shift()
        if (reserved) return reserved
        return super.mintRpcId()
    }

    protected override openMux(
        _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<RpcRequest<MuxFrame>> {
        return this.readWebSocket<MuxFrame>(MUX_EVENTS_PATH, signal, onOpen)
    }

    protected override openHost(
        _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<RpcRequest<HostFrame>> {
        return this.readWebSocket<HostFrame>(HOST_EVENTS_PATH, signal, onOpen)
    }

    /**
     * WebSocket pump mirroring the official browser client: each message is
     * one JSON `server-request` envelope; the frame payload is schema-validated
     * against the official frame schema; malformed frames are dropped without
     * killing the stream; close ends iteration; abort closes the socket.
     */
    private async *readWebSocket<F extends MuxFrame | HostFrame>(
        path: string,
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncGenerator<RpcRequest<F>> {
        const url = new URL(path, this.baseUrl)
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(url)
        const inbox: Array<{ kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }> = []
        let wake: (() => void) | undefined

        const enqueue = (item: { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }): void => {
            inbox.push(item)
            wake?.()
            wake = undefined
        }

        const handleOpen = (): void => {
            onOpen?.()
        }
        const handleMessage = (event: MessageEvent): void => {
            let full: ReturnType<typeof serverRequestSchema.parse>
            try {
                if (typeof event.data !== 'string') {
                    throw new Error('binary WebSocket frame')
                }
                full = serverRequestSchema.parse(JSON.parse(event.data))
            } catch (error) {
                // Same posture as the official client: one corrupt frame must
                // not kill the stream; the consumer's gap detection covers it.
                console.error(`[dsh] dropping malformed WebSocket frame on ${path}:`, error)
                return
            }
            try {
                const frame = path === MUX_EVENTS_PATH
                    ? muxFrameSchema.parse(full.payload) as F
                    : hostFrameSchema.parse(full.payload) as F
                enqueue({
                    kind: 'frame',
                    envelope: { rpcId: full.rpcId, payload: frame }
                })
            } catch (error) {
                console.error(`[dsh] dropping frame with invalid payload on ${path}:`, error)
            }
        }
        const handleClose = (): void => {
            enqueue({ kind: 'end' })
        }
        const handleAbort = (): void => {
            if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                socket.close()
            }
        }

        socket.addEventListener('open', handleOpen)
        socket.addEventListener('message', handleMessage)
        socket.addEventListener('close', handleClose, { once: true })
        signal.addEventListener('abort', handleAbort, { once: true })
        if (signal.aborted) {
            handleAbort()
        }
        try {
            while (true) {
                while (inbox.length > 0) {
                    const item = inbox.shift()!
                    if (item.kind === 'end') {
                        return
                    }
                    yield item.envelope
                }
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
        } finally {
            signal.removeEventListener('abort', handleAbort)
            socket.removeEventListener('open', handleOpen)
            socket.removeEventListener('message', handleMessage)
            socket.removeEventListener('close', handleClose)
            handleAbort()
        }
    }
}

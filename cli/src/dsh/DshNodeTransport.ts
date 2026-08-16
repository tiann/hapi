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
const SESSION_PROMPT_PATH = '/api/session.prompt'

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

    /** POST a session.prompt under a caller-owned rpcId. The caller reserves
     *  the id and registers its localId binding BEFORE the request leaves, so
     *  a user/message event that beats the HTTP response back still
     *  correlates. Unrelated unary calls keep their own minted ids — nothing
     *  shared can be consumed out from under a queued prompt. */
    async promptDirect(
        payload: Record<string, unknown>,
        rpcId: DshRpcId,
        externalSignal?: AbortSignal
    ): Promise<{ rpcId: string; result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: unknown } } }> {
        const message = { type: 'client-request', rpcId, method: 'session.prompt', payload }
        // Same POST leg as the official callUnary, with the caller-owned id.
        // Compose the caller's signal so a session stop cancels the in-flight
        // prompt instead of lingering up to the 30s transport timeout.
        const signal = externalSignal
            ? AbortSignal.any([AbortSignal.timeout(30_000), externalSignal])
            : AbortSignal.timeout(30_000)
        const response = await this.doFetch(new URL(SESSION_PROMPT_PATH, this.resolveBase()), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
            signal
        })
        if (!response.ok) {
            throw new Error(`session.prompt HTTP ${response.status}`)
        }
        let parsed: {
            type: string
            rpcId: string
            result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: unknown } }
        }
        try {
            parsed = await response.json() as typeof parsed
        } catch {
            throw new Error('session.prompt returned non-JSON body')
        }
        if (parsed?.type !== 'server-response' || !parsed.result) {
            throw new Error('session.prompt returned an unexpected envelope')
        }
        return { rpcId: parsed.rpcId, result: parsed.result }
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
        // Without an error handler an abrupt socket failure can leave the
        // generator parked forever (no close event); surface it as stream end
        // so the bridge's reconnect path takes over.
        const handleError = (): void => {
            enqueue({ kind: 'end' })
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
                try {
                    socket.close()
                } catch {
                    // CONNECTING close() throws in some runtimes; the socket
                    // dies anyway once the connection attempt fails.
                }
            }
        }

        socket.addEventListener('open', handleOpen)
        socket.addEventListener('message', handleMessage)
        socket.addEventListener('close', handleClose, { once: true })
        socket.addEventListener('error', handleError)
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
            socket.removeEventListener('error', handleError)
            handleAbort()
        }
    }
}

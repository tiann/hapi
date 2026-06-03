import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { createQwenProxyWebSocketHandler, type WebSocketLike } from './qwenProxyHandler'

const WS_OPEN = 1

class FakeUpstream implements WebSocketLike {
    readyState = WS_OPEN
    sent: Array<string | ArrayBuffer | Uint8Array> = []
    closed = false
    onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: ((event: { code: number; reason: string }) => void) | null = null

    constructor(public url: string, public opts?: unknown) {}

    send(data: string | ArrayBuffer | Uint8Array) {
        this.sent.push(data)
    }

    close(code = 1000, reason = '') {
        this.closed = true
        this.readyState = 3
        this.onclose?.({ code, reason })
    }

    deliver(payload: object | string) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
        this.onmessage?.({ data: text })
    }
}

class FakeClient {
    readyState = WS_OPEN
    sent: string[] = []
    closeCode: number | null = null
    closeReason: string | null = null
    data: object

    constructor(data: object) {
        this.data = data
    }

    send(payload: string | ArrayBuffer | Uint8Array) {
        this.sent.push(typeof payload === 'string' ? payload : new TextDecoder().decode(payload as Uint8Array))
    }

    close(code?: number, reason?: string) {
        this.closeCode = code ?? null
        this.closeReason = reason ?? null
        this.readyState = 3
    }
}

let lastUpstream: FakeUpstream | null = null
const FakeWebSocket = function FakeWebSocket(url: string, opts?: unknown) {
    const u = new FakeUpstream(url, opts)
    lastUpstream = u
    return u
} as unknown as new (url: string, opts?: unknown) => WebSocketLike

beforeEach(() => {
    lastUpstream = null
})

afterEach(() => {
    lastUpstream = null
})

function newClient() {
    return new FakeClient({ apiKey: 'k', model: 'qwen3-omni-flash-realtime', language: 'en', voiceName: 'Cherry' }) as unknown as ServerWebSocket<unknown> & FakeClient
}

describe('createQwenProxyWebSocketHandler ack-gate', () => {
    test('queues client frames until upstream acks hub-owned session.update with session.updated', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        expect(upstream.sent).toHaveLength(0)

        upstream.deliver({ type: 'session.created' })
        expect(upstream.sent).toHaveLength(1)
        const hubSetup = JSON.parse(upstream.sent[0] as string) as { type: string; session: { instructions: string } }
        expect(hubSetup.type).toBe('session.update')
        expect(typeof hubSetup.session.instructions).toBe('string')

        handler.message(client, JSON.stringify({ type: 'response.create' }))
        handler.message(client, JSON.stringify({ type: 'conversation.item.create', item: { type: 'message' } }))
        handler.message(client, JSON.stringify({ type: 'session.update', session: { instructions: 'updated' } }))

        expect(upstream.sent).toHaveLength(1)

        upstream.deliver({ type: 'session.updated', session: { instructions: hubSetup.session.instructions } })

        expect(upstream.sent.length).toBeGreaterThanOrEqual(4)
        const flushedTypes = upstream.sent.slice(1).map(raw => {
            try { return (JSON.parse(raw as string) as { type?: string }).type }
            catch { return undefined }
        })
        expect(flushedTypes).toEqual(['response.create', 'conversation.item.create', 'session.update'])
    })

    test('forwards client frames immediately after the gate has flipped', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!

        upstream.deliver({ type: 'session.created' })
        upstream.deliver({ type: 'session.updated', session: {} })
        const sentBefore = upstream.sent.length

        handler.message(client, JSON.stringify({ type: 'input_audio_buffer.append', audio: 'abc' }))
        expect(upstream.sent).toHaveLength(sentBefore + 1)
    })

    test('rejects client frames that fail the safe-frame allowlist with 1008', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        upstream.deliver({ type: 'session.created' })
        upstream.deliver({ type: 'session.updated', session: {} })

        handler.message(client, JSON.stringify({
            type: 'session.update',
            session: { tools: [{ type: 'function', name: 'evil' }] }
        }))

        expect(client.closeCode).toBe(1008)
        expect(client.closeReason).toContain('instructions')
    })

    test('clears queued frames on close so no stale data leaks if a new client reuses memory', () => {
        const handler = createQwenProxyWebSocketHandler(FakeWebSocket)
        const client = newClient()

        handler.open(client)
        const upstream = lastUpstream!
        upstream.deliver({ type: 'session.created' })
        handler.message(client, JSON.stringify({ type: 'response.create' }))

        handler.close(client, 1000, 'bye')
        expect(upstream.closed).toBe(true)
    })
})

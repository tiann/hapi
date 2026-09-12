import { describe, expect, it } from 'bun:test'
import { PreviewTunnel, type CliPreviewNamespace, type PreviewRequestMeta } from './previewTunnel'
import type { PreviewMountEntry } from './previewRegistry'
import type { PreviewFrame } from '@hapi/protocol/preview'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

function makeEntry(socketId = 'sock-1'): PreviewMountEntry {
    return {
        mountId: MOUNT_ID,
        socketId,
        namespace: 'default',
        sessionId: 'session-1',
        kind: 'static',
        name: 'site',
        rootPath: '/tmp/site',
        ws: true,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        lastSeenAt: Date.now()
    } as unknown as PreviewMountEntry
}

interface FakeNamespace {
    framesToCli: PreviewFrame[]
    sockets: Map<string, { emit: (event: string, frame: PreviewFrame) => void; connected: boolean }>
}

function makeNamespace(): { ns: CliPreviewNamespace; fake: FakeNamespace } {
    const fake: FakeNamespace = { framesToCli: [], sockets: new Map() }
    fake.sockets.set('sock-1', {
        connected: true,
        emit: (_event, frame) => fake.framesToCli.push(frame)
    })
    const ns = {
        sockets: fake.sockets
    } as unknown as CliPreviewNamespace
    return { ns, fake }
}

function httpMeta(overrides: Partial<PreviewRequestMeta> = {}): PreviewRequestMeta {
    return {
        method: 'GET',
        path: '',
        query: undefined,
        headers: { accept: 'text/html' },
        body: undefined,
        protocols: undefined,
        ...overrides
    }
}

describe('PreviewTunnel.openHttp', () => {
    it('sends an open frame and resolves the head from the CLI response', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        expect(conn).not.toBeNull()

        expect(fake.framesToCli).toEqual([
            expect.objectContaining({ type: 'open', mountId: MOUNT_ID, kind: 'http', method: 'GET' })
        ])

        const openFrame = fake.framesToCli[0] as { connId: string }
        tunnel.handleFrame('sock-1', { type: 'response', connId: openFrame.connId, status: 200, headers: { 'content-type': 'text/html' } })
        const head = await conn!.head
        expect(head?.status).toBe(200)
        expect(head?.headers['content-type']).toBe('text/html')
    })

    it('rejects frames from a foreign socket', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const openFrame = fake.framesToCli[0] as { connId: string }

        tunnel.handleFrame('sock-OTHER', { type: 'response', connId: openFrame.connId, status: 418, headers: {} })
        // Head must still be pending — abort the wait by closing.
        let settled = false
        void conn!.head.then(() => {
            settled = true
        })
        await Bun.sleep(10)
        expect(settled).toBe(false)
        conn!.close()
    })

    it('streams data frames into the body and closes it on end', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        tunnel.handleFrame('sock-1', { type: 'response', connId, status: 200, headers: {} })
        tunnel.handleFrame('sock-1', { type: 'data', connId, seq: 0, payload: new Uint8Array([1, 2, 3]) })
        tunnel.handleFrame('sock-1', { type: 'end', connId })

        const head = await conn!.head
        expect(head?.status).toBe(200)
        const reader = conn!.body.getReader()
        const chunk = await reader.read()
        expect(Array.from(chunk.value ?? [])).toEqual([1, 2, 3])
        expect((await reader.read()).done).toBe(true)
    })

    it('converts an error frame before the head into an error response', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        tunnel.handleFrame('sock-1', { type: 'error', connId, status: 502, message: 'dev server down' })

        const head = await conn!.head
        expect(head?.status).toBe(502)
        const reader = conn!.body.getReader()
        const chunk = await reader.read()
        expect(new TextDecoder().decode(chunk.value)).toContain('dev server down')
    })

    it('resolves a null head when the conn dies before a response (504 case)', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId
        tunnel.handleFrame('sock-1', { type: 'close', connId })
        expect(await conn!.head).toBeNull()
    })

    it('notifies the CLI when the browser aborts (cancel/close)', () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        tunnel.handleFrame('sock-1', { type: 'response', connId, status: 200, headers: {} })
        const reader = conn!.body.getReader()
        void reader.cancel()
        conn!.close()

        expect(fake.framesToCli.some((frame) => frame.type === 'close' && frame.connId === connId)).toBe(true)
    })
})

describe('PreviewTunnel.openWs', () => {
    it('relays ws frames both directions and closes on ws-close', () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openWs(makeEntry(), httpMeta({ protocols: 'vite-hmr' }))

        const openFrame = fake.framesToCli.find((frame) => frame.type === 'open') as { protocols?: string }
        expect(openFrame.protocols).toBe('vite-hmr')

        const seen: string[] = []
        conn!.onMessage((payload) => seen.push(String(payload)))
        conn!.onClose((code) => seen.push(`closed:${code}`))

        const connId = (fake.framesToCli[0] as { connId: string }).connId
        tunnel.handleFrame('sock-1', { type: 'ws-message', connId, isText: true, payload: 'hello' })
        conn!.send('reply', true)
        tunnel.handleFrame('sock-1', { type: 'ws-close', connId, code: 1000 })

        expect(seen).toEqual(['hello', 'closed:1000'])
        expect(fake.framesToCli.some((frame) => frame.type === 'ws-message' && frame.payload === 'reply')).toBe(true)
    })
})

describe('PreviewTunnel.detachSocket', () => {
    it('fails every conn behind the socket', async () => {
        const { ns } = makeNamespace()
        const tunnel = new PreviewTunnel(ns)
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        tunnel.detachSocket('sock-1')
        expect(await conn!.head).toBeNull()
        expect(tunnel.stats.conns).toBe(0)
    })
})

describe('PreviewTunnel lifecycle (regressions)', () => {
    it('sends pause when the queue exceeds the threshold and resume once the browser drains', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns, { pauseThresholdBytes: 1000, resumeThresholdBytes: 200 })
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        tunnel.handleFrame('sock-1', { type: 'response', connId, status: 200, headers: {} })
        tunnel.handleFrame('sock-1', { type: 'data', connId, seq: 0, payload: new Uint8Array(1500) })
        expect(fake.framesToCli.some((frame) => frame.type === 'pause' && frame.connId === connId)).toBe(true)

        // The browser drains the stream → pull must issue a resume frame.
        const reader = conn!.body.getReader()
        let total = (await reader.read()).value?.byteLength ?? 0
        await Bun.sleep(10)
        expect(fake.framesToCli.some((frame) => frame.type === 'resume' && frame.connId === connId)).toBe(true)

        // Keep reading to the end without stalling (buffered accounting drains).
        tunnel.handleFrame('sock-1', { type: 'end', connId })
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
        }
        expect(total).toBe(1500)
    })

    it('does not kill a healthy transfer after the open deadline once a head arrived', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns, { openTimeoutMs: 50 })
        const conn = tunnel.openHttp(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        tunnel.handleFrame('sock-1', { type: 'response', connId, status: 200, headers: {} })
        await conn!.head
        // Outlive the 50 ms deadline…
        await Bun.sleep(120)
        // …the stream must still accept data and the conn must stay open.
        tunnel.handleFrame('sock-1', { type: 'data', connId, seq: 0, payload: new Uint8Array([9, 9]) })
        const reader = conn!.body.getReader()
        const chunk = await reader.read()
        expect(Array.from(chunk.value ?? [])).toEqual([9, 9])
        expect(tunnel.stats.conns).toBe(1)
    })

    it('leaves established websocket conns alone (no head deadline)', async () => {
        const { ns, fake } = makeNamespace()
        const tunnel = new PreviewTunnel(ns, { openTimeoutMs: 50 })
        const conn = tunnel.openWs(makeEntry(), httpMeta())
        const connId = (fake.framesToCli[0] as { connId: string }).connId

        await Bun.sleep(120)
        const seen: string[] = []
        conn!.onMessage((payload) => seen.push(String(payload)))
        tunnel.handleFrame('sock-1', { type: 'ws-message', connId, isText: true, payload: 'late-but-alive' })
        expect(seen).toEqual(['late-but-alive'])
        expect(tunnel.stats.conns).toBe(1)
    })
})

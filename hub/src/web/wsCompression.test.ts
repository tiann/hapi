import { describe, expect, test } from 'bun:test'
import { applyDefaultWsCompression } from './wsCompression'

function makeFakeWs(): { ws: { send: (data: string | Bun.BufferSource, compress?: boolean) => number }; calls: Array<{ data: string | Bun.BufferSource; compress: boolean | undefined; self: unknown }> } {
    const calls: Array<{ data: string | Bun.BufferSource; compress: boolean | undefined; self: unknown }> = []
    const ws = {
        send(this: unknown, data: string | Bun.BufferSource, compress?: boolean): number {
            calls.push({ data, compress, self: this })
            return typeof data === 'string' ? data.length : data.byteLength
        }
    }
    return { ws, calls }
}

describe('applyDefaultWsCompression', () => {
    test('flagless send defaults to compress=true (bun-engine call shape)', () => {
        const { ws, calls } = makeFakeWs()
        applyDefaultWsCompression(ws)

        ws.send('payload')

        expect(calls).toHaveLength(1)
        expect(calls[0]?.compress).toBe(true)
        expect(calls[0]?.data).toBe('payload')
    })

    test('explicit flags are preserved in both directions', () => {
        const { ws, calls } = makeFakeWs()
        applyDefaultWsCompression(ws)

        ws.send('a', false)
        ws.send('b', true)

        expect(calls[0]?.compress).toBe(false)
        expect(calls[1]?.compress).toBe(true)
    })

    test('original send stays bound to the socket and returns its result', () => {
        const { ws, calls } = makeFakeWs()
        const original = ws.send
        applyDefaultWsCompression(ws)

        const result = ws.send('12345')

        expect(result).toBe(5)
        expect(ws.send).not.toBe(original)
        // bind() target must be the ws object, not the wrapper's caller
        expect(calls[0]?.self).toBe(ws)
    })

    test('binary payloads pass through untouched', () => {
        const { ws, calls } = makeFakeWs()
        applyDefaultWsCompression(ws)

        const buffer = new Uint8Array([1, 2, 3])
        const result = ws.send(buffer)

        expect(result).toBe(3)
        expect(calls[0]?.data).toBe(buffer)
        expect(calls[0]?.compress).toBe(true)
    })
})

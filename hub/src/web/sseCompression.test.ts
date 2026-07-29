import { describe, expect, it } from 'bun:test'
import zlib from 'node:zlib'
import { compressSseResponse } from './sseCompression'

function gunzip(data: Uint8Array): string {
    return zlib.gunzipSync(Buffer.from(data)).toString('utf8')
}

function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk))
            }
            controller.close()
        }
    })
    return new Response(body, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache'
        }
    })
}

async function readAll(response: Response): Promise<Uint8Array> {
    const reader = response.body!.getReader()
    const parts: Uint8Array[] = []
    for (;;) {
        const { done, value } = await reader.read()
        if (done) {
            break
        }
        parts.push(value)
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
        merged.set(part, offset)
        offset += part.length
    }
    return merged
}

describe('compressSseResponse', () => {
    it('leaves the response untouched when the client does not accept gzip', async () => {
        const original = sseResponse(['data: {"a":1}\n\n'])
        const result = compressSseResponse(original, undefined)

        expect(result).toBe(original)
        expect(result.headers.get('Content-Encoding')).toBeNull()
    })

    it('leaves the response untouched when Accept-Encoding lacks gzip', async () => {
        const original = sseResponse(['data: {"a":1}\n\n'])
        const result = compressSseResponse(original, 'br, deflate')

        expect(result).toBe(original)
    })

    it('gzips the stream and preserves the exact payload', async () => {
        const payload = 'data: {"type":"heartbeat","data":{"timestamp":1}}\n\n'
        const result = compressSseResponse(sseResponse([payload]), 'gzip, deflate')

        expect(result.headers.get('Content-Encoding')).toBe('gzip')
        expect(result.headers.get('Content-Type')).toBe('text/event-stream')
        expect(result.headers.get('Cache-Control')).toBe('no-cache')

        expect(gunzip(await readAll(result))).toBe(payload)
    })

    it('flushes every event immediately instead of buffering until the stream ends', async () => {
        // A SSE connection stays open for hours. If the compressor buffers,
        // events never reach the client. Each written event must produce
        // decompressible output before the stream closes.
        const encoder = new TextEncoder()
        let emit!: (value: string) => void
        let finish!: () => void
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                emit = (value) => controller.enqueue(encoder.encode(value))
                finish = () => controller.close()
            }
        })
        const source = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        const result = compressSseResponse(source, 'gzip')
        const reader = result.body!.getReader()
        const inflate = zlib.createGunzip()
        const seen: string[] = []
        inflate.on('data', (chunk: Buffer) => seen.push(chunk.toString('utf8')))

        emit('data: {"seq":1}\n\n')
        const first = await reader.read()
        expect(first.done).toBe(false)
        inflate.write(Buffer.from(first.value!))
        await new Promise<void>((resolve) => inflate.flush(() => resolve()))
        expect(seen.join('')).toBe('data: {"seq":1}\n\n')

        emit('data: {"seq":2}\n\n')
        const second = await reader.read()
        expect(second.done).toBe(false)
        inflate.write(Buffer.from(second.value!))
        await new Promise<void>((resolve) => inflate.flush(() => resolve()))
        expect(seen.join('')).toBe('data: {"seq":1}\n\ndata: {"seq":2}\n\n')

        finish()
    })

    it('passes through a response without a body', () => {
        const original = new Response(null, { status: 204 })
        expect(compressSseResponse(original, 'gzip')).toBe(original)
    })
})

describe('compressSseResponse cleanup', () => {
    it('cancels the upstream stream when the client goes away', async () => {
        // SSE clients disconnect mid-stream all the time; the source must be
        // told, or the subscription behind it leaks.
        let cancelledWith: unknown = Symbol('never')
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
            },
            cancel(reason) {
                cancelledWith = reason
            }
        })
        const result = compressSseResponse(
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
            'gzip'
        )
        const reader = result.body!.getReader()
        await reader.read()
        await reader.cancel('client gone')
        await new Promise((resolve) => setTimeout(resolve, 20))

        expect(cancelledWith).toBe('client gone')
    })

    it('does not reject when the client cancels', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
            }
        })
        const result = compressSseResponse(
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
            'gzip'
        )
        const rejections: unknown[] = []
        const onRejection = (reason: unknown) => rejections.push(reason)
        process.on('unhandledRejection', onRejection)

        const reader = result.body!.getReader()
        await reader.read()
        await reader.cancel('client gone')
        await new Promise((resolve) => setTimeout(resolve, 50))
        process.off('unhandledRejection', onRejection)

        expect(rejections).toEqual([])
    })
})

describe('compressSseResponse content negotiation', () => {
    it('honours an explicit q=0 refusal', () => {
        const original = sseResponse(['data: {"a":1}\n\n'])
        expect(compressSseResponse(original, 'gzip;q=0, deflate')).toBe(original)
    })

    it('still compresses when a q-value is present but non-zero', () => {
        const result = compressSseResponse(sseResponse(['data: {"a":1}\n\n']), 'gzip;q=0.5')
        expect(result.headers.get('Content-Encoding')).toBe('gzip')
    })

    it('compresses for a wildcard accept', () => {
        const result = compressSseResponse(sseResponse(['data: {"a":1}\n\n']), '*')
        expect(result.headers.get('Content-Encoding')).toBe('gzip')
    })
})

describe('compressSseResponse backpressure', () => {
    it('stops pulling from the source while the consumer is not reading', async () => {
        // A slow client must not make the hub buffer without bound.
        let produced = 0
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                produced += 1
                controller.enqueue(encoder.encode(`data: {"seq":${produced},"pad":"${'x'.repeat(4000)}"}\n\n`))
            }
        })
        const result = compressSseResponse(
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
            'gzip'
        )
        const reader = result.body!.getReader()
        await reader.read()
        // Consumer goes quiet; production must not run away.
        await new Promise((resolve) => setTimeout(resolve, 120))
        const idle = produced

        await reader.read()
        await new Promise((resolve) => setTimeout(resolve, 60))

        expect(idle).toBeLessThan(200)
        expect(produced).toBeGreaterThanOrEqual(idle)
        await reader.cancel('done')
    })
})

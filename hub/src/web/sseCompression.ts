import zlib from 'node:zlib'

/**
 * Wraps an SSE response in a gzip stream when the client accepts it.
 *
 * SSE payloads are plain JSON with the same field names repeated on every
 * event, so they compress extremely well (~75% on real traffic). The catch is
 * that the standard compressors buffer: `CompressionStream` and Hono's
 * `compress()` middleware only emit once the stream ends, which for a
 * connection that stays open for hours means events never arrive. We therefore
 * drive zlib directly and issue a Z_SYNC_FLUSH after every chunk, which costs
 * about one percentage point of ratio and keeps delivery immediate.
 *
 * (Hono's `compress()` would skip this response anyway - it bails out when
 * `Transfer-Encoding` is set, and `streamSSE` always sets it.)
 */
export function compressSseResponse(response: Response, acceptEncoding: string | undefined): Response {
    if (!acceptEncoding?.toLowerCase().includes('gzip') || !response.body) {
        return response
    }

    const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
    const source = response.body

    const compressed = new ReadableStream<Uint8Array>({
        start(controller) {
            gzip.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk))
            })
            gzip.on('end', () => {
                controller.close()
            })
            gzip.on('error', (error) => {
                controller.error(error)
            })

            void (async () => {
                const reader = source.getReader()
                try {
                    for (;;) {
                        const { done, value } = await reader.read()
                        if (done) {
                            break
                        }
                        gzip.write(Buffer.from(value))
                        gzip.flush(zlib.constants.Z_SYNC_FLUSH)
                    }
                } catch (error) {
                    gzip.destroy(error as Error)
                    return
                } finally {
                    reader.releaseLock()
                }
                gzip.end()
            })()
        },
        cancel(reason) {
            gzip.destroy(reason instanceof Error ? reason : undefined)
            void source.cancel(reason)
        }
    })

    const headers = new Headers(response.headers)
    headers.set('Content-Encoding', 'gzip')
    headers.delete('Content-Length')

    return new Response(compressed, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}

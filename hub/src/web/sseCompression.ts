import zlib from 'node:zlib'

/**
 * True when the client is willing to receive gzip.
 *
 * `Accept-Encoding: gzip;q=0` means the opposite of what a substring match
 * would suggest, so parse the q-value rather than looking for the word. All
 * entries are read before deciding because an explicit `gzip` entry takes
 * precedence over `*` regardless of where it appears in the header (RFC 9110
 * §12.5.3): `*;q=1, gzip;q=0` refuses gzip, `*;q=0, gzip;q=1` accepts it.
 * Exported because the API compression middleware needs the same q-aware
 * negotiation (hono's compress() matches by substring and would gzip for
 * clients that explicitly refuse it).
 */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
    if (!acceptEncoding) {
        return false
    }
    let gzipQ: number | null = null
    let wildcardQ: number | null = null
    for (const part of acceptEncoding.split(',')) {
        const [rawName, ...params] = part.split(';')
        const name = rawName?.trim().toLowerCase()
        if (name !== 'gzip' && name !== '*') {
            continue
        }
        const qParam = params
            .map((param) => param.trim().toLowerCase())
            .find((param) => param.startsWith('q='))
        // Absent or unparseable q counts as 1 (the header's default weight);
        // repeated entries let the last one win.
        const parsed = qParam ? Number(qParam.slice(2)) : 1
        const q = Number.isFinite(parsed) ? parsed : 1
        if (name === 'gzip') {
            gzipQ = q
        } else {
            wildcardQ = q
        }
    }
    const effective = gzipQ ?? wildcardQ
    return effective !== null && effective > 0
}

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
    if (!acceptsGzip(acceptEncoding) || !response.body) {
        return response
    }

    const gzip = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH })
    const source = response.body
    // Acquired synchronously so `cancel` can always reach it. Cancelling
    // `source` directly would throw: it is locked for as long as we hold a
    // reader, which is the whole lifetime of the connection.
    const reader = source.getReader()
    let resumeRead: (() => void) | null = null

    const compressed = new ReadableStream<Uint8Array>({
        start(controller) {
            // Gate reading on downstream demand. Checking only zlib's own
            // buffer is not enough: SSE compresses so well that a slow client
            // can be megabytes behind while the compressed queue still looks
            // nearly empty.
            const awaitDemand = (): Promise<void> => {
                if ((controller.desiredSize ?? 1) > 0) {
                    return Promise.resolve()
                }
                return new Promise<void>((resolve) => {
                    resumeRead = resolve
                })
            }

            gzip.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk))
                if ((controller.desiredSize ?? 1) <= 0) {
                    gzip.pause()
                }
            })
            gzip.on('end', () => {
                controller.close()
            })
            gzip.on('error', (error) => {
                controller.error(error)
            })

            void (async () => {
                try {
                    for (;;) {
                        await awaitDemand()
                        const { done, value } = await reader.read()
                        if (done) {
                            break
                        }
                        if (!gzip.write(Buffer.from(value))) {
                            await new Promise<void>((resolve) => gzip.once('drain', resolve))
                        }
                        gzip.flush(zlib.constants.Z_SYNC_FLUSH)
                    }
                } catch (error) {
                    gzip.destroy(error as Error)
                    return
                }
                gzip.end()
            })()
        },
        pull() {
            gzip.resume()
            const resume = resumeRead
            resumeRead = null
            resume?.()
        },
        cancel(reason) {
            gzip.destroy()
            resumeRead?.()
            resumeRead = null
            return reader.cancel(reason)
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

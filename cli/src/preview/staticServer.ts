import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { PREVIEW_MAX_FILE_BYTES, PREVIEW_FRAME_PAYLOAD_BYTES, type PreviewOpenFrame } from '@hapi/protocol/preview'

import { logger } from '@/ui/logger'

import { lookupMimeType } from './mime'
import { isInsideRoot, isRealpathInsideRoot, resolveSubPath } from './pathGuard'
import type { PreviewConnHandlers, PreviewConnSink } from './tunnelClient'
import type { PreviewMount } from './mountManager'

/**
 * Static mount terminator: answers one browser request by streaming a file
 * from the mount root over the tunnel. Read-only, no directory listing,
 * traversal/symlink hardened, bounded at 25 MiB per file.
 */

const TEXT_CACHE_CONTROL = 'no-cache'
const ASSET_CACHE_CONTROL = 'public, max-age=60'

/** Strips weakness and quotes so `W/"x"`, `"x"` and `x` compare equal. */
function normalizeEtag(value: string | undefined): string {
    return (value ?? '').trim().replace(/^W\//i, '').replace(/^"|"$/g, '')
}

function etagFor(size: number, mtimeMs: number): string {
    return `W/"${size}-${Math.round(mtimeMs)}"`
}

function baseHeaders(mimeType: string, etag: string): Record<string, string> {
    return {
        'content-type': mimeType,
        etag,
        'x-content-type-options': 'nosniff',
        'cache-control': mimeType.startsWith('text/html') ? TEXT_CACHE_CONTROL : ASSET_CACHE_CONTROL
    }
}

/** Terminal error before any head was sent — the hub synthesizes the response. */
function failEarly(sink: PreviewConnSink, status: number, message: string): void {
    sink.error(status, message)
}

function redirectDirectory(frame: PreviewOpenFrame, sink: PreviewConnSink): void {
    const rawName = frame.path.split('/').filter(Boolean).pop() ?? ''
    let encoded: string
    try {
        encoded = encodeURIComponent(decodeURIComponent(rawName))
    } catch {
        failEarly(sink, 400, 'Bad Request')
        return
    }
    sink.respond({ status: 301, headers: { location: `${encoded}/` } })
    sink.end()
}

export function serveStaticMount(mount: PreviewMount, frame: PreviewOpenFrame, sink: PreviewConnSink): PreviewConnHandlers {
    // Handlers are returned synchronously; the async body fills them in so the
    // tunnel can pause/resume/destroy the stream from the first frame onward.
    const handlers: PreviewConnHandlers = {
        onFlow() {},
        onClose() {}
    }

    const method = (frame.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
        sink.respond({ status: 405, headers: { allow: 'GET, HEAD' } })
        sink.end()
        return handlers
    }

    const rootPath = mount.rootPath ?? ''
    const resolved = resolveSubPath(rootPath, frame.path)
    if (!resolved || !isInsideRoot(rootPath, resolved.absolutePath)) {
        failEarly(sink, 404, 'Not Found')
        return handlers
    }

    void (async () => {
        let stats = await stat(resolved.absolutePath).catch((error: NodeJS.ErrnoException) => {
            failEarly(sink, error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 404, error.code === 'EACCES' ? 'Forbidden' : 'Not Found')
            return null
        })
        if (!stats) return

        if (stats.isDirectory()) {
            if (!resolved.trailingSlash) {
                redirectDirectory(frame, sink)
                return
            }
            // Directory: serve index.html or 404 — never a listing.
            const indexPath = `${resolved.absolutePath.replace(/\/+$/, '')}/index.html`
            const indexStats = await stat(indexPath).catch(() => null)
            if (!indexStats?.isFile()) {
                failEarly(sink, 404, 'Not Found')
                return
            }
            stats = indexStats
            resolved.absolutePath = indexPath
            resolved.mimeType = lookupMimeType(indexPath)
        }

        if (!stats.isFile()) {
            failEarly(sink, 404, 'Not Found')
            return
        }
        if (stats.size > PREVIEW_MAX_FILE_BYTES) {
            failEarly(sink, 413, 'Payload Too Large')
            return
        }
        // Symlinks must not escape the (real) mount root.
        if (!(await isRealpathInsideRoot(rootPath, resolved.absolutePath))) {
            failEarly(sink, 404, 'Not Found')
            return
        }

        const etag = etagFor(stats.size, stats.mtimeMs)
        if (normalizeEtag(frame.headers['if-none-match']) === normalizeEtag(etag)) {
            sink.respond({ status: 304, headers: baseHeaders(resolved.mimeType, etag) })
            sink.end()
            return
        }

        sink.respond({
            status: 200,
            headers: { ...baseHeaders(resolved.mimeType, etag), 'content-length': String(stats.size) }
        })
        if (method === 'HEAD') {
            sink.end()
            return
        }

        const stream = createReadStream(resolved.absolutePath, { highWaterMark: PREVIEW_FRAME_PAYLOAD_BYTES })
        stream.on('data', (chunk: Buffer) => {
            sink.data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        })
        stream.on('end', () => sink.end())
        stream.on('error', (error) => {
            logger.debug('[preview] Static read failed mid-response:', error instanceof Error ? error.message : String(error))
            // The head is already out — aborting is the only honest terminal.
            sink.close()
        })
        handlers.onFlow = (action) => {
            if (action === 'pause') stream.pause()
            else stream.resume()
        }
        handlers.onClose = () => stream.destroy()
    })().catch((error) => {
        logger.debug('[preview] Static serve failed:', error instanceof Error ? error.message : String(error))
        // `error` after a sent head is ignored hub-side (treated as abort).
        sink.error(500, 'Internal Server Error')
    })

    return handlers
}

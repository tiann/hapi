import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { WebAppEnv } from './middleware/auth'
import { createPreviewRoutes } from './previewRoutes'
import type { PreviewRegistry } from '../preview/previewRegistry'
import type { PreviewRequestMeta, PreviewTunnel } from '../preview/previewTunnel'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const PREFIX = `/preview/${MOUNT_ID}`

function makeDeps(options: {
    entry?: Record<string, unknown> | null
    tombstoned?: boolean
    openHttp?: (entry: unknown, meta: PreviewRequestMeta) => unknown
} = {}) {
    const opened: PreviewRequestMeta[] = []
    const registry = {
        get: () => (options.entry === null ? null : { mountId: MOUNT_ID, token: undefined, ws: true, ...(options.entry ?? {}) }),
        isTombstoned: () => options.tombstoned ?? false,
        checkToken: () => true
    } as unknown as PreviewRegistry
    const tunnel = {
        openHttp: (entry: unknown, meta: PreviewRequestMeta) => {
            opened.push(meta)
            return options.openHttp?.(entry, meta) ?? {
                head: Promise.resolve({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
                body: new ReadableStream<Uint8Array>({
                    start: (controller) => {
                        controller.enqueue(new TextEncoder().encode('<html>ok</html>'))
                        controller.close()
                    }
                }),
                close: () => {}
            }
        }
    } as unknown as PreviewTunnel
    return { deps: { previewRegistry: registry, previewTunnel: tunnel }, opened }
}

function buildApp(deps: { previewRegistry: PreviewRegistry; previewTunnel: PreviewTunnel }): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.route('/preview', createPreviewRoutes(deps))
    return app
}

describe('preview routes', () => {
    it('serves a mounted preview without hub auth', async () => {
        const { deps } = makeDeps()
        const response = await buildApp(deps).request(`${PREFIX}/index.html`)

        expect(response.status).toBe(200)
        expect(await response.text()).toContain('ok')
    })

    it('returns 404 for unknown mounts and 410 for tombstoned ones', async () => {
        const missing = makeDeps({ entry: null })
        const notFound = await buildApp(missing.deps).request(`${PREFIX}/`)
        expect(notFound.status).toBe(404)

        const tombstoned = makeDeps({ entry: null, tombstoned: true })
        const gone = await buildApp(tombstoned.deps).request(`${PREFIX}/`)
        expect(gone.status).toBe(410)
        expect(await gone.text()).toContain('re-mount')
    })

    it('forwards the sub-path, method and sanitized headers to the tunnel', async () => {
        const { deps, opened } = makeDeps()
        await buildApp(deps).request(`${PREFIX}/assets/app.js?v=2`, {
            method: 'GET',
            headers: { 'accept': 'text/css', 'connection': 'keep-alive', 'x-custom': 'kept' }
        })

        expect(opened).toHaveLength(1)
        expect(opened[0].method).toBe('GET')
        expect(opened[0].path).toBe('assets/app.js')
        expect(opened[0].query).toBe('v=2')
        expect(opened[0].headers['accept']).toBe('text/css')
        // hop-by-hop dropped, forwarding metadata added
        expect(opened[0].headers['connection']).toBeUndefined()
        expect(opened[0].headers['x-forwarded-prefix']).toBe(PREFIX)
        expect(opened[0].headers['via']).toBe('hapi-preview')
    })

    it('rejects oversized request bodies locally with 413', async () => {
        const { deps, opened } = makeDeps()
        const body = new Uint8Array(1024 * 1024 + 1)
        const response = await buildApp(deps).request(`${PREFIX}/upload`, {
            method: 'POST',
            body,
            headers: { 'content-length': String(body.byteLength) }
        })
        expect(response.status).toBe(413)
        expect(opened).toHaveLength(0)
    })

    it('answers 502 when the tunnel conn dies before a head', async () => {
        const { deps } = makeDeps({
            openHttp: () => ({
                head: Promise.resolve(null),
                body: new ReadableStream<Uint8Array>({ start: () => {} }),
                close: () => {}
            })
        })
        const response = await buildApp(deps).request(`${PREFIX}/`)
        expect(response.status).toBe(502)
    })
})

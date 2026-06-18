import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => ({
                success: true,
                content: pngBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Generated images are content-addressed by an immutable random id, so they must be
        // cacheable; `no-store` forces a full RPC round-trip on every remount (issue #927).
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImage: async () => {
                rpcCalls += 1
                return { success: true, content: '', mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })
})

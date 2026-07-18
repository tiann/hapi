import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SSEManager } from '../../sse/sseManager'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'

function createApp(engine: Partial<SyncEngine>, managerOverrides: Partial<SSEManager> = {}) {
    const manager = {
        canAcceptSubscription: () => true,
        subscribe: () => {
            throw new Error('terminal rejection should not subscribe')
        },
        unsubscribe: () => {},
        ...managerOverrides
    } as unknown as SSEManager

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createEventsRoutes(() => manager, () => engine as SyncEngine, () => null))
    return app
}

describe('events routes', () => {
    it('emits a terminal SSE rejection instead of HTTP 429 when namespace subscription cap is reached', async () => {
        const app = createApp({}, {
            canAcceptSubscription: () => false
        })

        const response = await app.request('/api/events?all=true')
        const text = await response.text()

        expect(response.status).toBe(200)
        expect(text).toContain('"type":"connection-changed"')
        expect(text).toContain('"status":"rejected"')
        expect(text).toContain('"reason":"too-many-subscriptions"')
    })

    it('emits a terminal SSE rejection for stale machine targets', async () => {
        const app = createApp({
            getMachine: () => undefined
        })

        const response = await app.request('/api/events?machineId=missing')
        const text = await response.text()

        expect(response.status).toBe(200)
        expect(text).toContain('"type":"connection-changed"')
        expect(text).toContain('"status":"rejected"')
        expect(text).toContain('"reason":"machine-not-found"')
    })

    it('emits a terminal SSE rejection for stale session targets', async () => {
        const app = createApp({
            resolveSessionAccess: () => ({ ok: false, reason: 'not-found' })
        })

        const response = await app.request('/api/events?sessionId=missing')
        const text = await response.text()

        expect(response.status).toBe(200)
        expect(text).toContain('"type":"connection-changed"')
        expect(text).toContain('"status":"rejected"')
        expect(text).toContain('"reason":"session-not-found"')
    })
})

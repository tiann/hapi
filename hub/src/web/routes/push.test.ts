import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { PushPayload } from '../../push/pushService'
import type { WebAppEnv } from '../middleware/auth'
import { createPushRoutes } from './push'

function createApp(sendToNamespace: (namespace: string, payload: PushPayload) => Promise<number>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createPushRoutes({} as never, 'test-key', { sendToNamespace } as never))
    return app
}

describe('POST /api/push/test', () => {
    it('returns success when at least one subscription receives the push', async () => {
        const sent: Array<{ namespace: string; payload: PushPayload }> = []
        const app = createApp(async (namespace, payload) => {
            sent.push({ namespace, payload })
            return 1
        })

        const response = await app.request('/api/push/test', { method: 'POST' })

        expect(response.status).toBe(200)
        expect(sent[0]?.namespace).toBe('default')
        expect(sent[0]?.payload.tag).toBe('test-push')
    })

    it('returns 503 when no subscription receives the push', async () => {
        const app = createApp(async () => 0)

        const response = await app.request('/api/push/test', { method: 'POST' })

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'No push notification was delivered' })
    })
})

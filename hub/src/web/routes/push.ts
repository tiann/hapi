import { Hono } from 'hono'
import { z } from 'zod'
import type { PushService } from '../../push/pushService'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const subscriptionSchema = z.object({
    endpoint: z.string().min(1),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1)
    })
})

const unsubscribeSchema = z.object({
    endpoint: z.string().min(1)
})

export function createPushRoutes(
    store: Store,
    vapidPublicKey: string,
    pushService: PushService
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/push/vapid-public-key', (c) => {
        return c.json({ publicKey: vapidPublicKey })
    })

    app.post('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = subscriptionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const { endpoint, keys } = parsed.data
        store.push.addPushSubscription(namespace, {
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth
        })

        return c.json({ ok: true })
    })

    app.delete('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = unsubscribeSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        store.push.removePushSubscription(namespace, parsed.data.endpoint)
        return c.json({ ok: true })
    })

    // User-initiated test push: deliberately bypasses notification preferences.
    app.post('/push/test', async (c) => {
        const namespace = c.get('namespace')
        try {
            const delivered = await pushService.sendToNamespace(namespace, {
                title: 'HAPI Test Notification',
                body: 'Your push notifications are working.',
                tag: 'test-push',
                data: {
                    type: 'test',
                    sessionId: '',
                    url: '/settings/notifications'
                }
            })
            if (delivered === 0) {
                return c.json({ error: 'No push notification was delivered' }, 503)
            }
            return c.json({ ok: true })
        } catch (error) {
            console.error('[PushRoutes] Test push failed:', error)
            return c.json({ error: 'Failed to send test push' }, 500)
        }
    })

    return app
}

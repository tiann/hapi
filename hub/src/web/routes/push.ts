import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const subscriptionSchema = z.object({
    endpoint: z.string().min(1),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1)
    }),
    /** Browser UI language (BCP-47 tag); used for localized notification text. */
    language: z.string().trim().min(1).max(35).optional().nullable()
})

const unsubscribeSchema = z.object({
    endpoint: z.string().min(1)
})

export function createPushRoutes(store: Store, vapidPublicKey: string): Hono<WebAppEnv> {
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
        const { endpoint, keys, language } = parsed.data
        store.push.addPushSubscription(namespace, {
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            language: language ?? null
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

    return app
}

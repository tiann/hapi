import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const registerSchema = z.object({
    token: z.string().min(1),
    platform: z.enum(['phone', 'wear']),
    deviceId: z.string().min(1).max(128)
})

const unregisterSchema = z.object({
    token: z.string().min(1)
})

export function createDevicesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/devices/register', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = registerSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        store.fcm.upsertDevice(namespace, parsed.data)
        return c.json({ ok: true })
    })

    app.delete('/devices/register', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = unregisterSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        store.fcm.removeDeviceByToken(namespace, parsed.data.token)
        return c.json({ ok: true })
    })

    return app
}

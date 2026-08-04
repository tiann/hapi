import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const updateSchema = z.object({
    permissionRequests: z.number().min(0).max(1).optional(),
    sessionReady: z.number().min(0).max(1).optional(),
    taskNotifications: z.number().min(0).max(1).optional(),
    sessionCompletion: z.number().min(0).max(1).optional()
})

export function createNotificationPreferencesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/notification-preferences', (c) => {
        const namespace = c.get('namespace')
        return c.json(store.notificationPrefs.getPreferences(namespace))
    })

    app.put('/notification-preferences', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = updateSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const namespace = c.get('namespace')
        return c.json(store.notificationPrefs.setPreferences(namespace, parsed.data))
    })

    return app
}

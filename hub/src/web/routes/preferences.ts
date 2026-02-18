import { Hono } from 'hono'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const updatePreferencesSchema = z.object({
    readyAnnouncements: z.boolean().optional()
})

export function createPreferencesRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/preferences', (c) => {
        const namespace = c.get('namespace')
        const preferences = store.userPreferences.get(namespace)
        return c.json({
            readyAnnouncements: preferences.readyAnnouncements
        })
    })

    app.post('/preferences', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = updatePreferencesSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const current = store.userPreferences.get(namespace)
        const nextReadyAnnouncements = parsed.data.readyAnnouncements ?? current.readyAnnouncements
        const saved = store.userPreferences.setReadyAnnouncements(namespace, nextReadyAnnouncements)

        return c.json({
            ok: true,
            preferences: {
                readyAnnouncements: saved.readyAnnouncements
            }
        })
    })

    return app
}

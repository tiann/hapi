import { Hono } from 'hono'
import { getSettingsFile, readSettingsOrThrow, writeSettings } from '../../config/settings'
import {
    COPY_KEYS,
    DEFAULT_COPY,
    notificationCopySchema,
    type CopyKey,
    type NotificationCopyConfig
} from '../../push/notificationCopy'
import type { WebAppEnv } from '../middleware/auth'

function isAdmin(namespace: string): boolean {
    return namespace === 'default'
}

export function createNotificationCopyRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const settingsFile = getSettingsFile(dataDir)

    app.get('/notification-copy', async (c) => {
        const namespace = c.get('namespace')
        if (!isAdmin(namespace)) {
            return c.json({ error: 'Forbidden: admin only' }, 403)
        }
        const settings = await readSettingsOrThrow(settingsFile)
        const parsed = notificationCopySchema.safeParse(settings.notificationCopy ?? {})
        return c.json({
            copy: parsed.success ? parsed.data : {},
            defaults: DEFAULT_COPY
        })
    })

    app.put('/notification-copy', async (c) => {
        const namespace = c.get('namespace')
        if (!isAdmin(namespace)) {
            return c.json({ error: 'Forbidden: admin only' }, 403)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = notificationCopySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Read-modify-write: preserve every other settings.json key.
        const settings = await readSettingsOrThrow(settingsFile)
        const copy: NotificationCopyConfig = {}
        for (const key of COPY_KEYS) {
            const template = parsed.data[key]
            if (template) {
                copy[key as CopyKey] = template
            }
        }
        settings.notificationCopy = copy
        await writeSettings(settingsFile, settings)
        return c.json({
            copy,
            defaults: DEFAULT_COPY
        })
    })

    return app
}

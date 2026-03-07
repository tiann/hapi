import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { getConfiguration } from '../../configuration'
import { readSettings, writeSettings, type Settings, getSettingsFile } from '../../config/settings'
import type { Store } from '../../store'

const telegramConfigSchema = z.object({
    telegramBotToken: z.string().min(1).optional(),
    telegramNotification: z.boolean().optional(),
    publicUrl: z.string().url().optional(),
})

export interface TelegramConfigResponse {
    enabled: boolean
    telegramBotToken: string | null
    telegramNotification: boolean
    publicUrl: string
    tokenSource: 'env' | 'file' | 'default'
    notificationSource: 'env' | 'file' | 'default'
    urlSource: 'env' | 'file' | 'default'
}

export function createTelegramRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/telegram/config', async (c) => {
        const config = getConfiguration()

        const response: TelegramConfigResponse = {
            enabled: config.telegramEnabled,
            telegramBotToken: config.telegramBotToken,
            telegramNotification: config.telegramNotification,
            publicUrl: config.publicUrl,
            tokenSource: config.sources.telegramBotToken,
            notificationSource: config.sources.telegramNotification,
            urlSource: config.sources.publicUrl,
        }

        return c.json(response)
    })

    app.post('/telegram/config', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = telegramConfigSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const config = getConfiguration()
        const settingsFile = getSettingsFile(config.dataDir)
        const settings = await readSettings(settingsFile) ?? {}

        // Update settings with new values
        if (parsed.data.telegramBotToken !== undefined) {
            settings.telegramBotToken = parsed.data.telegramBotToken
        }
        if (parsed.data.telegramNotification !== undefined) {
            settings.telegramNotification = parsed.data.telegramNotification
        }
        if (parsed.data.publicUrl !== undefined) {
            settings.publicUrl = parsed.data.publicUrl
        }

        await writeSettings(settingsFile, settings)

        return c.json({
            success: true,
            message: 'Configuration saved. Please restart the hub for changes to take effect.',
        })
    })

    app.delete('/telegram/config/token', async (c) => {
        const config = getConfiguration()
        const settingsFile = getSettingsFile(config.dataDir)
        const settings = await readSettings(settingsFile) ?? {}

        // Remove token from settings
        delete settings.telegramBotToken
        await writeSettings(settingsFile, settings)

        return c.json({
            success: true,
            message: 'Telegram bot token removed. Please restart the hub for changes to take effect.',
        })
    })

    return app
}

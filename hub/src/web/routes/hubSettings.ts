import { Hono } from 'hono'
import { UpdateHubSettingsRequestSchema, type HubSettingsResponse } from '@hapi/protocol'
import {
    getSettingsFile,
    readSettingsOrThrow,
    updateSettings,
    type Settings
} from '../../config/settings'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

function toHubSettings(settings: Settings): HubSettingsResponse {
    return {
        sessionSummaryContract: settings.sessionSummaryContract === true,
        sessionSummaryInChat: settings.sessionSummaryInChat === true
    }
}

export function createHubSettingsRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Authenticated readers (any namespace) can observe hub-wide display/emit
    // flags. Mutations stay owner-only below.
    app.get('/hub-settings', async (c) => {
        c.header('Cache-Control', 'no-store')
        const settings = await readSettingsOrThrow(getSettingsFile(dataDir))
        return c.json(toHubSettings(settings))
    })

    app.put('/hub-settings', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = UpdateHubSettingsRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const response = await updateSettings(getSettingsFile(dataDir), (current) => {
            const settings: Settings = { ...current }
            if (parsed.data.sessionSummaryContract !== undefined) {
                settings.sessionSummaryContract = parsed.data.sessionSummaryContract
            }
            if (parsed.data.sessionSummaryInChat !== undefined) {
                settings.sessionSummaryInChat = parsed.data.sessionSummaryInChat
            }
            return {
                settings,
                result: toHubSettings(settings)
            }
        })
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}

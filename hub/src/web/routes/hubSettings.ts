import { Hono } from 'hono'
import { UpdateHubSettingsRequestSchema, type HubSettingsResponse } from '@hapi/protocol'
import {
    readSessionSummaryContractEnabled,
    writeSessionSummaryContractEnabled
} from '../../config/sessionSummaryContract'
import {
    readSessionSummaryInChatEnabled,
    writeSessionSummaryInChatEnabled
} from '../../config/sessionSummaryInChat'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

async function readHubSettings(dataDir: string): Promise<HubSettingsResponse> {
    const [sessionSummaryContract, sessionSummaryInChat] = await Promise.all([
        readSessionSummaryContractEnabled(dataDir),
        readSessionSummaryInChatEnabled(dataDir)
    ])
    return { sessionSummaryContract, sessionSummaryInChat }
}

export function createHubSettingsRoutes(dataDir: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Authenticated readers (any namespace) can observe hub-wide display/emit
    // flags. Mutations stay owner-only below.
    app.get('/hub-settings', async (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json(await readHubSettings(dataDir))
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
        if (parsed.data.sessionSummaryContract !== undefined) {
            await writeSessionSummaryContractEnabled(dataDir, parsed.data.sessionSummaryContract)
        }
        if (parsed.data.sessionSummaryInChat !== undefined) {
            await writeSessionSummaryInChatEnabled(dataDir, parsed.data.sessionSummaryInChat)
        }
        c.header('Cache-Control', 'no-store')
        return c.json(await readHubSettings(dataDir))
    })

    return app
}

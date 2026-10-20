import { Hono } from 'hono'
import { UpdateHubSettingsRequestSchema, type HubSettingsResponse } from '@hapi/protocol'
import {
    readAutoBridgeTransientModelErrorsEnabled,
    writeAutoBridgeTransientModelErrorsEnabled
} from '../../config/autoBridgeTransientModelErrors'
import {
    readSessionSummaryContractEnabled,
    writeSessionSummaryContractEnabled
} from '../../config/sessionSummaryContract'
import {
    readSessionSummaryInChatEnabled,
    writeSessionSummaryInChatEnabled
} from '../../config/sessionSummaryInChat'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

async function readHubSettings(dataDir: string): Promise<HubSettingsResponse> {
    const [sessionSummaryContract, sessionSummaryInChat, autoBridgeTransientModelErrors] = await Promise.all([
        readSessionSummaryContractEnabled(dataDir),
        readSessionSummaryInChatEnabled(dataDir),
        readAutoBridgeTransientModelErrorsEnabled(dataDir)
    ])
    return {
        sessionSummaryContract,
        sessionSummaryInChat,
        autoBridgeTransientModelErrors
    }
}

export function createHubSettingsRoutes(
    dataDir: string,
    getSyncEngine?: () => SyncEngine | null
): Hono<WebAppEnv> {
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
        const providedFieldCount = [
            parsed.data.sessionSummaryContract,
            parsed.data.sessionSummaryInChat,
            parsed.data.autoBridgeTransientModelErrors
        ].filter((value) => value !== undefined).length
        if (providedFieldCount > 1) {
            return c.json({ error: 'Update one hub setting per request' }, 400)
        }
        if (parsed.data.sessionSummaryContract !== undefined) {
            await writeSessionSummaryContractEnabled(
                dataDir,
                parsed.data.sessionSummaryContract
            )
        }
        if (parsed.data.sessionSummaryInChat !== undefined) {
            await writeSessionSummaryInChatEnabled(
                dataDir,
                parsed.data.sessionSummaryInChat
            )
        }
        if (parsed.data.autoBridgeTransientModelErrors !== undefined) {
            const enabled = parsed.data.autoBridgeTransientModelErrors
            const engine = getSyncEngine?.() ?? null
            if (engine) {
                try {
                    // Disk write + fanout + rollback share SyncEngine's lock so
                    // concurrent PUTs cannot leave CLI prefs ahead of settings.json.
                    await engine.applyAutoBridgeTransientModelErrorsSetting(dataDir, enabled)
                } catch (error) {
                    const message = error instanceof Error
                        ? error.message
                        : 'Failed to update every active Cursor session'
                    return c.json({ error: message }, 409)
                }
            } else {
                await writeAutoBridgeTransientModelErrorsEnabled(dataDir, enabled)
            }
        }
        c.header('Cache-Control', 'no-store')
        return c.json(await readHubSettings(dataDir))
    })

    return app
}

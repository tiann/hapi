import { Hono } from 'hono'
import { UpdateHubSettingsRequestSchema, type HubSettingsResponse } from '@hapi/protocol'
import { mergePeerSpawnDefaults } from '@hapi/protocol/peerSpawnDefaults'
import {
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from '../../config/settings'
import { applyPeerSpawnDefaultsPatch } from '../../config/peerSpawnDefaults'
import { writeAutoBridgeTransientModelErrorsEnabled } from '../../config/autoBridgeTransientModelErrors'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

function toHubSettings(settings: Settings): HubSettingsResponse {
    return {
        sessionSummaryContract: settings.sessionSummaryContract === true,
        sessionSummaryInChat: settings.sessionSummaryInChat === true,
        autoBridgeTransientModelErrors: settings.autoBridgeTransientModelErrors === true,
        peerSpawnDefaults: mergePeerSpawnDefaults(settings.peerSpawnDefaults)
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
        const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
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
        const providedFieldCount = [
            parsed.data.sessionSummaryContract,
            parsed.data.sessionSummaryInChat,
            parsed.data.autoBridgeTransientModelErrors
        ].filter((value) => value !== undefined).length
        if (providedFieldCount > 1) {
            return c.json({ error: 'Update one hub setting per request' }, 400)
        }
        // Auto-bridge is not a plain settings write: SyncEngine fans the pref out
        // to live Cursor CLIs and rolls the disk value back if any session refuses.
        // Keep it outside the updateSettings transaction so the engine owns both
        // halves under its own lock; the write still goes through updateSettings
        // underneath, so the settings read cache stays write-through fresh.
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
        const response = await updateSettings(getSettingsFile(dataDir), (current) => {
            const settings: Settings = { ...current }
            if (parsed.data.sessionSummaryContract !== undefined) {
                settings.sessionSummaryContract = parsed.data.sessionSummaryContract
            }
            if (parsed.data.sessionSummaryInChat !== undefined) {
                settings.sessionSummaryInChat = parsed.data.sessionSummaryInChat
            }
            if (parsed.data.peerSpawnDefaults !== undefined) {
                settings.peerSpawnDefaults = applyPeerSpawnDefaultsPatch(
                    current,
                    parsed.data.peerSpawnDefaults
                )
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

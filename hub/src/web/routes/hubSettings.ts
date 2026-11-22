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
import {
    readTelemetryLevelState,
    writeTelemetryLevel
} from '../../config/telemetryLevel'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const OWNER_ONLY_ERROR = 'Hub settings are only available to the hub owner'

async function toHubSettings(settings: Settings, dataDir: string): Promise<HubSettingsResponse> {
    const levelState = await readTelemetryLevelState(dataDir)
    return {
        sessionSummaryContract: settings.sessionSummaryContract === true,
        sessionSummaryInChat: settings.sessionSummaryInChat === true,
        autoBridgeTransientModelErrors: settings.autoBridgeTransientModelErrors === true,
        peerSpawnDefaults: mergePeerSpawnDefaults(settings.peerSpawnDefaults),
        telemetryLevel: levelState.level,
        telemetryLevelSource: levelState.source
    }
}

export function createHubSettingsRoutes(
    dataDir: string,
    getSyncEngine?: () => SyncEngine | null,
    store?: Store
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // Authenticated readers (any namespace) can observe hub-wide display/emit
    // flags. Mutations stay owner-only below.
    app.get('/hub-settings', async (c) => {
        c.header('Cache-Control', 'no-store')
        const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
        return c.json(await toHubSettings(settings, dataDir))
    })

    app.put('/hub-settings', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: OWNER_ONLY_ERROR }, 403)
        }
        const json = await c.req.json().catch(() => null)
        // telemetryLevel is a first-class field of the shared
        // UpdateHubSettingsRequestSchema (0-3 enforced there); the one-field-
        // per-request discipline below counts it like any other setting.
        const parsed = UpdateHubSettingsRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }
        const fields = parsed.data
        const providedFieldCount = [
            parsed.data.sessionSummaryContract,
            parsed.data.sessionSummaryInChat,
            parsed.data.autoBridgeTransientModelErrors,
            fields.telemetryLevel
        ].filter((value) => value !== undefined).length
        if (providedFieldCount > 1) {
            return c.json({ error: 'Update one hub setting per request' }, 400)
        }
        // A telemetryLevel write under an env pin must be refused, not silently
        // shadowed — otherwise the operator thinks they changed the level.
        if (fields.telemetryLevel !== undefined) {
            const levelState = await readTelemetryLevelState(dataDir)
            if (levelState.source === 'env') {
                return c.json({
                    error: 'telemetryLevel is pinned by HAPI_TELEMETRY_LEVEL',
                    code: 'telemetry_level_pinned_by_env'
                }, 409)
            }
            await writeTelemetryLevel(dataDir, fields.telemetryLevel)
            // Flip the hub-plane perf gate immediately (review finding #1):
            // without this the middleware keeps (not) recording at the old
            // level until the next engine tick refreshes the cached value.
            // Optional-chained twice: lighter test harnesses pass partial
            // stores without the telemetry facade.
            await store?.telemetry?.refreshLevel(dataDir)
            const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
            c.header('Cache-Control', 'no-store')
            return c.json(await toHubSettings(settings, dataDir))
        }
        // Auto-bridge is not a plain settings write: SyncEngine fans the pref out
        // to live Cursor CLIs and rolls the disk value back if any session refuses.
        // Keep it outside the updateSettings transaction so the engine owns both
        // halves under its own lock; the write still goes through updateSettings
        // underneath, so the settings read cache stays write-through fresh.
        if (fields.autoBridgeTransientModelErrors !== undefined) {
            const enabled = fields.autoBridgeTransientModelErrors
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
        const response = await updateSettings(getSettingsFile(dataDir), async (current) => {
            const settings: Settings = { ...current }
            if (fields.sessionSummaryContract !== undefined) {
                settings.sessionSummaryContract = fields.sessionSummaryContract
            }
            if (fields.sessionSummaryInChat !== undefined) {
                settings.sessionSummaryInChat = fields.sessionSummaryInChat
            }
            if (fields.peerSpawnDefaults !== undefined) {
                settings.peerSpawnDefaults = applyPeerSpawnDefaultsPatch(
                    current,
                    fields.peerSpawnDefaults
                )
            }
            return {
                settings,
                result: await toHubSettings(settings, dataDir)
            }
        })
        c.header('Cache-Control', 'no-store')
        return c.json(response)
    })

    return app
}

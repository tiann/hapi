/**
 * API URL initialization module
 *
 * Handles HAPI_API_URL initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Settings file (~/.hapi/settings.json)
 * 3. Default value (http://localhost:3006)
 *
 * Values are normalized before use: a hub URL without a scheme used to fail
 * later with a cryptic fetch error, so it is repaired (HTTPS by default, HTTP
 * for loopback and private hosts) while unusable values fail with an
 * actionable message.
 */

import { normalizeHubUrl } from '@hapi/protocol'
import { configuration } from '@/configuration'
import { readSettings, updateSettings } from '@/persistence'

/** Where the active hub URL came from after initializeApiUrl(). */
export type ApiUrlSource = 'env' | 'settings' | 'default'

function applyHubUrl(raw: string, source: 'env' | 'settings'): string {
    const normalized = normalizeHubUrl(raw)
    if (!normalized) {
        const origin = source === 'env' ? 'HAPI_API_URL' : 'settings.json apiUrl'
        throw new Error(
            `${origin} must be an absolute http(s) URL without embedded credentials, ` +
            `e.g. https://hapi.example.com (got "${raw}")`
        )
    }
    if (normalized !== raw.trim()) {
        const hint = source === 'env'
            ? 'Update HAPI_API_URL to silence this warning.'
            : 'settings.json has been updated to match.'
        console.warn(
            `[WARN] Hub URL "${raw.trim()}" was normalized to "${normalized}". ${hint}`
        )
    }
    configuration._setApiUrl(normalized)
    return normalized
}

/**
 * Initialize API URL
 * Must be called before any API operations
 */
export async function initializeApiUrl(): Promise<ApiUrlSource> {
    // 1. Environment variable has highest priority (allows temporary override).
    //    Env values are never persisted, matching the CLI_API_TOKEN handling.
    const envUrl = process.env.HAPI_API_URL
    if (envUrl) {
        applyHubUrl(envUrl, 'env')
        return 'env'
    }

    // 2. Read from settings file (new name first, then legacy).
    //    `||` rather than `??` so an empty apiUrl still falls back to the legacy field.
    const settings = await readSettings()
    const storedApiUrl = settings.apiUrl
    const storedUrl = storedApiUrl || settings.serverUrl
    if (storedUrl) {
        const normalized = applyHubUrl(storedUrl, 'settings')
        // Persist the repair and finish the legacy migration: drop an empty
        // apiUrl and the legacy serverUrl so later reads take the fast path.
        if (normalized !== storedUrl || !storedApiUrl) {
            await updateSettings((current) => {
                const next = { ...current, apiUrl: normalized }
                delete next.serverUrl
                return next
            })
        }
        return 'settings'
    }

    // 3. Default value already set in configuration constructor
    return 'default'
}

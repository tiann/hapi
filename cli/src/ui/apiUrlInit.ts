/**
 * API URL initialization module
 *
 * Handles HAPI_API_URL initialization with priority:
 * 1. Environment variable (highest - allows temporary override)
 * 2. Settings file (~/.hapi/settings.json)
 * 3. Default value (http://localhost:3006)
 */

import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'

/** Where the active hub URL came from after initializeApiUrl(). */
export type ApiUrlSource = 'env' | 'settings' | 'default'

/**
 * Initialize API URL
 * Must be called before any API operations
 */
export async function initializeApiUrl(): Promise<ApiUrlSource> {
    // 1. Environment variable has highest priority (allows temporary override)
    if (process.env.HAPI_API_URL) {
        return 'env'
    }

    // 2. Read from settings file (new name first, then legacy)
    const settings = await readSettings()
    if (settings.apiUrl) {
        configuration._setApiUrl(settings.apiUrl)
        return 'settings'
    }
    if (settings.serverUrl) {
        // Migrate from legacy field name
        configuration._setApiUrl(settings.serverUrl)
        return 'settings'
    }

    // 3. Default value already set in configuration constructor
    return 'default'
}

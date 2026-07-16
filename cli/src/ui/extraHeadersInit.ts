import { configuration, normalizeExtraHeaders } from '@/configuration'
import { readSettings } from '@/persistence'

export async function initializeExtraHeaders(): Promise<void> {
    if (process.env.HAPI_EXTRA_HEADERS_JSON !== undefined) {
        return
    }

    const settings = await readSettings()
    if (settings.extraHeaders === undefined) {
        return
    }

    configuration._setExtraHeaders(
        normalizeExtraHeaders(settings.extraHeaders, 'settings.json extraHeaders')
    )
}

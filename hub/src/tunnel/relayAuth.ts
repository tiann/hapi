/**
 * Relay auth key resolution
 *
 * Priority: HAPI_RELAY_AUTH env > persisted per-hub key > freshly issued key.
 * The relay server only accepts per-hub HMAC keys issued via /issue; once
 * obtained the key is persisted to settings.json so every hub has a stable,
 * individually revocable identity. A persisted key rejected by /add is
 * discarded and replaced once. Failure to obtain a key is fatal for the
 * tunnel — there is no shared-key fallback.
 */

import { readSettings, updateSettings, type Settings } from '../config/settings'

type FetchRelayAuth = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

async function issueRelayAuthKey(
    apiDomain: string,
    settingsFile: string,
    settings: Settings | null,
    fetchRelayAuth: FetchRelayAuth
): Promise<string> {
    const resp = await fetchRelayAuth(`https://${apiDomain}/issue`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000)
    })
    if (!resp.ok) {
        if (resp.status === 429) {
            const retryAfter = resp.headers.get('Retry-After')
            const retryHint = retryAfter
                ? ` Retry after ${retryAfter} seconds.`
                : ' Retry later.'
            throw new Error(
                'Relay key issuance rate-limited (HTTP 429). ' +
                'The relay limits issuance per public IP.' + retryHint +
                ' Configure HAPI_RELAY_AUTH if an operator provided a key.'
            )
        }
        throw new Error(`Relay at ${apiDomain} refused to issue an auth key (HTTP ${resp.status}).`)
    }
    const data = await resp.json() as { key?: string }
    if (typeof data.key !== 'string' || !data.key) {
        throw new Error(`Relay at ${apiDomain} returned an invalid key response.`)
    }
    // settings === null means the file exists but is unparseable; don't clobber it
    if (settings !== null) {
        await updateSettings(settingsFile, (current) => ({
            ...current,
            relayAuthKey: data.key
        }))
    }
    console.log('[Tunnel] Obtained per-hub relay auth key')
    return data.key
}

export async function resolveRelayAuthKey(
    apiDomain: string,
    settingsFile: string,
    fetchRelayAuth: FetchRelayAuth = fetch
): Promise<string> {
    const envKey = process.env.HAPI_RELAY_AUTH
    if (envKey) {
        return envKey
    }

    const settings = await readSettings(settingsFile)
    if (settings?.relayAuthKey) {
        return settings.relayAuthKey
    }

    return issueRelayAuthKey(apiDomain, settingsFile, settings, fetchRelayAuth)
}

export async function refreshRejectedRelayAuthKey(
    apiDomain: string,
    settingsFile: string,
    rejectedKey: string,
    fetchRelayAuth: FetchRelayAuth = fetch
): Promise<string> {
    if (process.env.HAPI_RELAY_AUTH) {
        throw new Error(
            'HAPI_RELAY_AUTH was rejected by the relay (HTTP 403). ' +
            'Update or unset the environment variable; persisted settings cannot override it.'
        )
    }

    const settings = await readSettings(settingsFile)
    if (settings === null) {
        throw new Error(`Cannot refresh relay auth while ${settingsFile} is unreadable.`)
    }
    if (settings.relayAuthKey && settings.relayAuthKey !== rejectedKey) {
        return settings.relayAuthKey
    }

    const cleared = await updateSettings(settingsFile, (current) => {
        const next = { ...current }
        delete next.relayAuthKey
        return next
    })
    console.warn('[Tunnel] Relay auth key rejected; requesting a replacement')
    return issueRelayAuthKey(apiDomain, settingsFile, cleared, fetchRelayAuth)
}

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { APNS_PRODUCTION_HOST, APNS_SANDBOX_HOST } from './apnsClient'

export const DEFAULT_PUSH_RELAY_URL = 'https://push.hapi.run'

/**
 * Transport selection (PUSH SPEC v1), resolved from hub configuration —
 * env vs settings.json precedence is folded upstream (serverSettings.ts;
 * env names in parentheses):
 *   iosPushMode (HAPI_IOS_PUSH) = apns | relay | off      (default: relay)
 *   iosPushRelayUrl (HAPI_PUSH_RELAY_URL)                 (default: https://push.hapi.run)
 *   direct mode requires apnsKeyP8Path, apnsKeyId, apnsTeamId, apnsBundleId
 *   (APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID);
 *   apnsEnv (APNS_ENV) = production | sandbox (default: production).
 *
 * `relay` is the default because it needs zero operator setup - and it only
 * ever carries ciphertext (see envelope.ts), so defaulting to the official
 * relay leaks nothing. Self-hosters who own an Apple developer account can
 * switch to `apns` and cut the relay out entirely.
 */
export type IosPushConfig =
    | { mode: 'off'; reason: string }
    | { mode: 'relay'; relayUrl: string; source: 'configured' | 'default' }
    | {
        mode: 'apns'
        keyP8: string
        keyP8Path: string
        keyId: string
        teamId: string
        bundleId: string
        env: 'production' | 'sandbox'
        host: string
    }

/** The slice of hub configuration iOS push cares about. */
export type IosPushSettings = {
    iosPushMode: string | null
    iosPushRelayUrl: string | null
    apnsKeyP8Path: string | null
    apnsKeyId: string | null
    apnsTeamId: string | null
    apnsBundleId: string | null
    apnsEnv: string | null
}

export function resolveIosPushConfig(settings: IosPushSettings): IosPushConfig {
    const rawMode = settings.iosPushMode?.trim().toLowerCase() || 'relay'
    const mode = rawMode === 'apns' || rawMode === 'relay' || rawMode === 'off'
        ? rawMode
        : ((): 'relay' => {
            console.warn(`[IosPush] Unknown iosPushMode value "${rawMode}"; falling back to default "relay"`)
            return 'relay'
        })()

    if (mode === 'off') {
        return { mode: 'off', reason: 'iosPushMode=off' }
    }

    if (mode === 'relay') {
        const rawUrl = settings.iosPushRelayUrl?.trim()
        return {
            mode: 'relay',
            relayUrl: rawUrl || DEFAULT_PUSH_RELAY_URL,
            source: rawUrl ? 'configured' : 'default'
        }
    }

    const keyP8Path = (settings.apnsKeyP8Path?.trim() ?? '').replace(/^~/, homedir())
    const keyId = settings.apnsKeyId?.trim() ?? ''
    const teamId = settings.apnsTeamId?.trim() ?? ''
    const bundleId = settings.apnsBundleId?.trim() ?? ''

    const missing: string[] = []
    if (!keyP8Path) missing.push('apnsKeyP8Path (APNS_KEY_P8_PATH)')
    if (!keyId) missing.push('apnsKeyId (APNS_KEY_ID)')
    if (!teamId) missing.push('apnsTeamId (APNS_TEAM_ID)')
    if (!bundleId) missing.push('apnsBundleId (APNS_BUNDLE_ID)')
    if (missing.length > 0) {
        const reason = `iosPushMode=apns but missing ${missing.join(', ')}`
        console.warn(`[IosPush] ${reason}; iOS push disabled`)
        return { mode: 'off', reason }
    }

    let keyP8: string
    try {
        keyP8 = readFileSync(keyP8Path, 'utf8')
    } catch (e) {
        const reason = `cannot read apnsKeyP8Path (${keyP8Path}): ${e instanceof Error ? e.message : e}`
        console.warn(`[IosPush] ${reason}; iOS push disabled`)
        return { mode: 'off', reason }
    }

    const rawEnv = settings.apnsEnv?.trim().toLowerCase()
    const apnsEnv: 'production' | 'sandbox' = rawEnv === 'sandbox' ? 'sandbox' : 'production'

    return {
        mode: 'apns',
        keyP8,
        keyP8Path,
        keyId,
        teamId,
        bundleId,
        env: apnsEnv,
        host: apnsEnv === 'sandbox' ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST
    }
}

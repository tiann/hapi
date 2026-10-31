import { resolveFcmConfig, type FcmConfig, type FcmSettings } from './fcmConfig'
import { DEFAULT_PUSH_RELAY_URL } from '../push-native/relayClient'

export type AndroidPushSettings = FcmSettings & {
    androidPushMode: string | null
    // Shared relay URL; retain the persisted name so existing iOS overrides work.
    iosPushRelayUrl: string | null
}

export type AndroidPushConfig =
    | { mode: 'off'; reason: string }
    | { mode: 'relay'; relayUrl: string }
    | { mode: 'fcm'; fcm: FcmConfig }

export function resolveAndroidPushConfig(settings: AndroidPushSettings): AndroidPushConfig {
    const mode = settings.androidPushMode?.trim().toLowerCase() || 'auto'
    if (mode === 'off') return { mode, reason: 'androidPushMode=off' }
    if (!['auto', 'relay', 'fcm'].includes(mode)) {
        return { mode: 'off', reason: `Unknown androidPushMode: ${mode}` }
    }
    // Decide from the configured path, not its validity. A broken private
    // project must never silently switch to the official relay's project.
    if (mode === 'relay' || (mode === 'auto' && !settings.fcmServiceAccountPath?.trim())) {
        return { mode: 'relay', relayUrl: settings.iosPushRelayUrl?.trim() || DEFAULT_PUSH_RELAY_URL }
    }
    try {
        const fcm = resolveFcmConfig(settings)
        if (fcm) return { mode: 'fcm', fcm }
    } catch {
        // Do not echo the JSON/parser error: it may contain private key material.
        return { mode: 'off', reason: 'Cannot load FCM service account; check FCM_SERVICE_ACCOUNT_PATH' }
    }
    return { mode: 'off', reason: 'Missing or invalid FCM service account; check FCM_SERVICE_ACCOUNT_PATH' }
}

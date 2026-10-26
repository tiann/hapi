/**
 * Configuration for the HAPI push relay.
 *
 * Everything comes from environment variables so the relay runs as a single
 * container with no config file. See relay/README.md for the full table.
 */
import { join } from 'node:path'

export const APNS_HOSTS = {
    production: 'https://api.push.apple.com',
    sandbox: 'https://api.sandbox.push.apple.com'
} as const

export type ApnsEnvironment = keyof typeof APNS_HOSTS

export const DEFAULT_RELAY_PORT = 8790

/**
 * Maximum accepted `envelope` size, measured on the base64 string as
 * transmitted (base64 is ASCII, so string length === byte length).
 * 3200 base64 chars ~= 2400 bytes of ciphertext; together with the fixed
 * APNs/FCM wrapper this stays below their 4096-byte payload caps.
 * Must match the hub-side caps in push-ios/ and fcm/androidRelayService.ts.
 */
export const MAX_ENVELOPE_BYTES = 3200

/** Per-device-token budget: 30 pushes/minute, burst 30. */
export const TOKEN_RATE_LIMIT = { capacity: 30, refillPerMinute: 30 }

/** Per-client-IP budget: 300 pushes/minute, burst 300. */
export const IP_RATE_LIMIT = { capacity: 300, refillPerMinute: 300 }

export type RelayApnsConfig = {
    /** Path to the APNs auth key (.p8, PKCS#8 PEM) on disk. */
    apnsKeyP8Path: string
    /** APNs key id (the 10-char id shown in the developer portal). */
    apnsKeyId: string
    /** Apple developer team id. */
    apnsTeamId: string
    /** iOS app bundle id, sent as `apns-topic`. */
    apnsBundleId: string
    /** Which APNs endpoint to talk to. */
    apnsEnv: ApnsEnvironment
}

export type RelayConfig = {
    apns: RelayApnsConfig | null
    fcm: { serviceAccountPath: string; packageName: string } | null
    /** TCP port for the relay's own HTTP server. */
    port: number
    /**
     * When true, take the client IP for rate limiting from the first hop of
     * `x-forwarded-for`. Only enable behind a trusted reverse proxy that
     * overwrites the header, otherwise clients can spoof their way past the
     * per-IP limit.
     */
    trustProxy: boolean
}

function requireEnv(env: Record<string, string | undefined>, name: string): string {
    const value = env[name]
    if (value === undefined || value.trim() === '') {
        throw new Error(`Missing required environment variable ${name}`)
    }
    return value.trim()
}

export function loadConfigFromEnv(
    env: Record<string, string | undefined> = process.env
): RelayConfig {
    const apnsEnvRaw = env.RELAY_APNS_ENV?.trim() || 'production'
    if (apnsEnvRaw !== 'production' && apnsEnvRaw !== 'sandbox') {
        throw new Error(
            `RELAY_APNS_ENV must be "production" or "sandbox", got "${apnsEnvRaw}"`
        )
    }

    const portRaw = env.RELAY_PORT?.trim()
    const port = portRaw === undefined || portRaw === ''
        ? DEFAULT_RELAY_PORT
        : Number.parseInt(portRaw, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`RELAY_PORT must be an integer in 1..65535, got "${portRaw}"`)
    }

    const trustProxyRaw = env.RELAY_TRUST_PROXY?.trim().toLowerCase()
    const trustProxy = trustProxyRaw === '1' || trustProxyRaw === 'true'

    const apnsKeys = ['RELAY_APNS_KEY_P8_PATH', 'RELAY_APNS_KEY_ID', 'RELAY_APNS_TEAM_ID', 'RELAY_APNS_BUNDLE_ID']
    const apns = apnsKeys.some(key => env[key]?.trim()) ? {
        apnsKeyP8Path: requireEnv(env, 'RELAY_APNS_KEY_P8_PATH'),
        apnsKeyId: requireEnv(env, 'RELAY_APNS_KEY_ID'),
        apnsTeamId: requireEnv(env, 'RELAY_APNS_TEAM_ID'),
        apnsBundleId: requireEnv(env, 'RELAY_APNS_BUNDLE_ID'),
        apnsEnv: apnsEnvRaw as ApnsEnvironment
    } : null
    const fcmPath = env.RELAY_FCM_SERVICE_ACCOUNT_PATH?.trim()
    if (!apns && !fcmPath) {
        throw new Error('Configure APNs credentials or RELAY_FCM_SERVICE_ACCOUNT_PATH')
    }
    const packageName = env.RELAY_FCM_PACKAGE_NAME?.trim() || 'run.hapi.companion'
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
        throw new Error('RELAY_FCM_PACKAGE_NAME must be an Android application ID')
    }
    return {
        apns,
        fcm: fcmPath ? { serviceAccountPath: fcmPath, packageName } : null,
        port,
        trustProxy
    }
}

/** Version reported by GET /health; read from relay/package.json at startup. */
export async function readRelayVersion(): Promise<string> {
    try {
        const pkg = await Bun.file(join(import.meta.dir, '..', 'package.json')).json() as {
            version?: unknown
        }
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    } catch {
        return '0.0.0'
    }
}

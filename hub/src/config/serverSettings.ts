/**
 * Hub Settings Management
 *
 * Handles loading and persistence of hub configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use
 */

import { hasUrlScheme, normalizeHubUrl } from '@hapi/protocol'
import { deriveCorsOrigins, normalizeOrigins, parseCorsOriginsEnv } from './corsOrigins'
import { getSettingsFile, updateSettings } from './settings'

const OLD_SETTINGS_FIELDS = ['webappHost', 'webappPort', 'webappUrl'] as const

/**
 * Push delivery settings: all nullable strings under the same
 * env > file > null rule (defaults and validation live in the resolvers,
 * fcmConfig.ts / iosPushConfig.ts).
 */
const PUSH_SETTING_KEYS = [
    ['fcmServiceAccountPath', 'FCM_SERVICE_ACCOUNT_PATH'],
    ['androidPushMode', 'HAPI_ANDROID_PUSH'],
    ['iosPushMode', 'HAPI_IOS_PUSH'],
    ['iosPushRelayUrl', 'HAPI_PUSH_RELAY_URL'],
    ['apnsKeyP8Path', 'APNS_KEY_P8_PATH'],
    ['apnsKeyId', 'APNS_KEY_ID'],
    ['apnsTeamId', 'APNS_TEAM_ID'],
    ['apnsBundleId', 'APNS_BUNDLE_ID'],
    ['apnsEnv', 'APNS_ENV'],
] as const

export type PushSettingKey = (typeof PUSH_SETTING_KEYS)[number][0]

export interface ServerSettings {
    telegramBotToken: string | null
    telegramNotification: boolean
    serverChanSendKey: string | null
    serverChanNotification: boolean
    serverChanBackgroundOnly: boolean
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
    androidPushMode: string | null
    fcmServiceAccountPath: string | null
    iosPushMode: string | null
    iosPushRelayUrl: string | null
    apnsKeyP8Path: string | null
    apnsKeyId: string | null
    apnsTeamId: string | null
    apnsBundleId: string | null
    apnsEnv: string | null
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        telegramNotification: 'env' | 'file' | 'default'
        serverChanSendKey: 'env' | 'file' | 'default'
        serverChanNotification: 'env' | 'file' | 'default'
        serverChanBackgroundOnly: 'env' | 'file' | 'default'
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    } & Record<PushSettingKey, 'env' | 'file' | 'default'>
    savedToFile: boolean
}

function sameStringArray(left: string[] | undefined, right: string[]): boolean {
    if (!left || left.length !== right.length) {
        return false
    }
    return left.every((value, index) => value === right[index])
}

/**
 * Normalize the public URL and persist the repaired value.
 *
 * A scheme-less value (e.g. "hapi.example.com") used to parse as "not a URL",
 * which silently emptied the CORS allowlist and broke every absolute link the
 * hub emits. Repair it, tell the operator, and fail loudly when the value
 * cannot be a hub URL at all.
 */
function normalizePublicUrl(raw: string): string {
    const trimmed = raw.trim()
    const normalized = normalizeHubUrl(raw)
    if (!normalized) {
        throw new Error(
            `Invalid publicUrl "${raw}" (expected an absolute http(s) URL without embedded ` +
            'credentials, like https://example.com).'
        )
    }
    if (normalized !== trimmed && !hasUrlScheme(trimmed)) {
        console.warn(
            `[Hub] publicUrl "${trimmed}" is missing a scheme; using "${normalized}". ` +
            'Update HAPI_PUBLIC_URL or settings.json to silence this warning.'
        )
    } else if (normalized !== trimmed) {
        console.warn(
            `[Hub] publicUrl "${trimmed}" was normalized to "${normalized}". ` +
            'Update HAPI_PUBLIC_URL or settings.json to silence this warning.'
        )
    }
    return normalized
}

/**
 * Normalize the CORS allowlist and report entries nothing can ever match.
 */
function normalizeCorsOrigins(values: string[], source: 'env' | 'file'): string[] {
    const { origins, dropped, repaired } = normalizeOrigins(values)
    const hint = source === 'env'
        ? 'Update CORS_ORIGINS to silence this warning.'
        : 'settings.json has been updated to match.'
    for (const entry of dropped) {
        console.warn(
            `[Hub] Ignoring invalid CORS origin "${entry}" (expected an origin like ` +
            `https://example.com). ${hint}`
        )
    }
    for (const entry of repaired) {
        console.warn(
            `[Hub] CORS origin "${entry.from.trim()}" was normalized to "${entry.to}". ${hint}`
        )
    }
    return origins
}

function rejectOldSettingsFields(settings: object, settingsFile: string): void {
    const oldFields = OLD_SETTINGS_FIELDS.filter((field) => field in settings)
    if (oldFields.length === 0) {
        return
    }
    throw new Error(
        `Unsupported old settings field(s) in ${settingsFile}: ${oldFields.join(', ')}. ` +
        'Use listenHost, listenPort, and publicUrl.'
    )
}

/**
 * Load hub settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = getSettingsFile(dataDir)
    return updateSettings(settingsFile, (settings) => {
        rejectOldSettingsFields(settings, settingsFile)

        let needsSave = false
        const sources: ServerSettingsResult['sources'] = {
            telegramBotToken: 'default',
            telegramNotification: 'default',
            serverChanSendKey: 'default',
            serverChanNotification: 'default',
            serverChanBackgroundOnly: 'default',
            listenHost: 'default',
            listenPort: 'default',
            publicUrl: 'default',
            corsOrigins: 'default',
            androidPushMode: 'default',
            fcmServiceAccountPath: 'default',
            iosPushMode: 'default',
            iosPushRelayUrl: 'default',
            apnsKeyP8Path: 'default',
            apnsKeyId: 'default',
            apnsTeamId: 'default',
            apnsBundleId: 'default',
            apnsEnv: 'default',
        }
        // telegramBotToken: env > file > null
        let telegramBotToken: string | null = null
        if (process.env.TELEGRAM_BOT_TOKEN) {
            telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
            sources.telegramBotToken = 'env'
            if (settings.telegramBotToken === undefined) {
                settings.telegramBotToken = telegramBotToken
                needsSave = true
            }
        } else if (settings.telegramBotToken !== undefined) {
            telegramBotToken = settings.telegramBotToken
            sources.telegramBotToken = 'file'
        }

        // telegramNotification: env > file > true
        let telegramNotification = true
        if (process.env.TELEGRAM_NOTIFICATION !== undefined) {
            telegramNotification = process.env.TELEGRAM_NOTIFICATION === 'true'
            sources.telegramNotification = 'env'
            if (settings.telegramNotification === undefined) {
                settings.telegramNotification = telegramNotification
                needsSave = true
            }
        } else if (settings.telegramNotification !== undefined) {
            telegramNotification = settings.telegramNotification
            sources.telegramNotification = 'file'
        }

        // serverChanSendKey: env > file > null
        let serverChanSendKey: string | null = null
        if (process.env.SERVERCHAN_SENDKEY) {
            serverChanSendKey = process.env.SERVERCHAN_SENDKEY
            sources.serverChanSendKey = 'env'
            if (settings.serverChanSendKey === undefined) {
                settings.serverChanSendKey = serverChanSendKey
                needsSave = true
            }
        } else if (settings.serverChanSendKey !== undefined) {
            serverChanSendKey = settings.serverChanSendKey
            sources.serverChanSendKey = 'file'
        }

        // serverChanNotification: env > file > true
        let serverChanNotification = true
        if (process.env.SERVERCHAN_NOTIFICATION !== undefined) {
            serverChanNotification = process.env.SERVERCHAN_NOTIFICATION === 'true'
            sources.serverChanNotification = 'env'
            if (settings.serverChanNotification === undefined) {
                settings.serverChanNotification = serverChanNotification
                needsSave = true
            }
        } else if (settings.serverChanNotification !== undefined) {
            serverChanNotification = settings.serverChanNotification
            sources.serverChanNotification = 'file'
        }

        // serverChanBackgroundOnly: env > file > false
        let serverChanBackgroundOnly = false
        if (process.env.SERVERCHAN_BACKGROUND_ONLY !== undefined) {
            serverChanBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY === 'true'
            sources.serverChanBackgroundOnly = 'env'
            if (settings.serverChanBackgroundOnly === undefined) {
                settings.serverChanBackgroundOnly = serverChanBackgroundOnly
                needsSave = true
            }
        } else if (typeof settings.serverChanBackgroundOnly === 'boolean') {
            serverChanBackgroundOnly = settings.serverChanBackgroundOnly
            sources.serverChanBackgroundOnly = 'file'
        } else if (settings.serverChanBackgroundOnly !== undefined) {
            throw new Error('serverChanBackgroundOnly must be a boolean')
        }

        // listenHost: env > file > default
        let listenHost = '127.0.0.1'
        if (process.env.HAPI_LISTEN_HOST) {
            listenHost = process.env.HAPI_LISTEN_HOST
            sources.listenHost = 'env'
            if (settings.listenHost === undefined) {
                settings.listenHost = listenHost
                needsSave = true
            }
        } else if (settings.listenHost !== undefined) {
            listenHost = settings.listenHost
            sources.listenHost = 'file'
        }

        // listenPort: env > file > default
        let listenPort = 3006
        if (process.env.HAPI_LISTEN_PORT) {
            const parsed = parseInt(process.env.HAPI_LISTEN_PORT, 10)
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw new Error('HAPI_LISTEN_PORT must be a valid port number')
            }
            listenPort = parsed
            sources.listenPort = 'env'
            if (settings.listenPort === undefined) {
                settings.listenPort = listenPort
                needsSave = true
            }
        } else if (settings.listenPort !== undefined) {
            listenPort = settings.listenPort
            sources.listenPort = 'file'
        }

        // publicUrl: env > file > default
        let publicUrl = `http://localhost:${listenPort}`
        if (process.env.HAPI_PUBLIC_URL) {
            publicUrl = normalizePublicUrl(process.env.HAPI_PUBLIC_URL)
            sources.publicUrl = 'env'
            if (settings.publicUrl === undefined) {
                settings.publicUrl = publicUrl
                needsSave = true
            }
        } else if (settings.publicUrl !== undefined) {
            publicUrl = normalizePublicUrl(settings.publicUrl)
            sources.publicUrl = 'file'
            if (settings.publicUrl !== publicUrl) {
                settings.publicUrl = publicUrl
                needsSave = true
            }
        }

        // corsOrigins: env > file > derived from publicUrl
        let corsOrigins: string[]
        if (process.env.CORS_ORIGINS) {
            corsOrigins = normalizeCorsOrigins(parseCorsOriginsEnv(process.env.CORS_ORIGINS), 'env')
            sources.corsOrigins = 'env'
            if (settings.corsOrigins === undefined) {
                settings.corsOrigins = corsOrigins
                needsSave = true
            }
        } else if (settings.corsOrigins !== undefined) {
            corsOrigins = normalizeCorsOrigins(settings.corsOrigins, 'file')
            sources.corsOrigins = 'file'
            if (!sameStringArray(settings.corsOrigins, corsOrigins)) {
                settings.corsOrigins = corsOrigins
                needsSave = true
            }
        } else {
            corsOrigins = deriveCorsOrigins(publicUrl)
        }

        // Push settings: env > file > null, env persisted on first sight —
        // one loop instead of nine copies of the per-field block above.
        const push: Record<PushSettingKey, string | null> = {
            androidPushMode: null,
            fcmServiceAccountPath: null,
            iosPushMode: null,
            iosPushRelayUrl: null,
            apnsKeyP8Path: null,
            apnsKeyId: null,
            apnsTeamId: null,
            apnsBundleId: null,
            apnsEnv: null,
        }
        for (const [key, envName] of PUSH_SETTING_KEYS) {
            const envValue = process.env[envName]?.trim()
            if (envValue) {
                push[key] = envValue
                sources[key] = 'env'
                if (settings[key] === undefined) {
                    settings[key] = envValue
                    needsSave = true
                }
            } else if (settings[key] !== undefined) {
                push[key] = settings[key] ?? null
                sources[key] = 'file'
            }
        }

        return {
            settings,
            write: needsSave,
            result: {
                settings: {
                    telegramBotToken,
                    telegramNotification,
                    serverChanSendKey,
                    serverChanNotification,
                    serverChanBackgroundOnly,
                    listenHost,
                    listenPort,
                    publicUrl,
                    corsOrigins,
                    ...push,
                },
                sources,
                savedToFile: needsSave,
            },
        }
    })
}

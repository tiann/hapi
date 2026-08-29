/**
 * Hub Settings Management
 *
 * Handles loading and persistence of hub configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use
 */

import { getSettingsFile, updateSettings } from './settings'

const OLD_SETTINGS_FIELDS = ['webappHost', 'webappPort', 'webappUrl'] as const

/**
 * Push delivery settings: all nullable strings under the same
 * env > file > null rule (defaults and validation live in the resolvers,
 * fcmConfig.ts / iosPushConfig.ts).
 */
const PUSH_SETTING_KEYS = [
    ['fcmServiceAccountPath', 'FCM_SERVICE_ACCOUNT_PATH'],
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
    wxPusherAppToken: string | null
    wxPusherUids: string[]
    wxPusherTopicIds: number[]
    wxPusherNotification: boolean
    wxPusherBackgroundOnly: boolean
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
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
        wxPusherAppToken: 'env' | 'file' | 'default'
        wxPusherUids: 'env' | 'file' | 'default'
        wxPusherTopicIds: 'env' | 'file' | 'default'
        wxPusherNotification: 'env' | 'file' | 'default'
        wxPusherBackgroundOnly: 'env' | 'file' | 'default'
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    } & Record<PushSettingKey, 'env' | 'file' | 'default'>
    savedToFile: boolean
}

/**
 * Parse and normalize CORS origins
 */
function parseCorsOrigins(str: string): string[] {
    const entries = str
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)

    if (entries.includes('*')) {
        return ['*']
    }

    const normalized: string[] = []
    for (const entry of entries) {
        try {
            normalized.push(new URL(entry).origin)
        } catch {
            // Keep raw value if it's already an origin-like string
            normalized.push(entry)
        }
    }
    return normalized
}

/**
 * Derive CORS origins from public URL
 */
function deriveCorsOrigins(publicUrl: string): string[] {
    try {
        return [new URL(publicUrl).origin]
    } catch {
        return []
    }
}

function parseCommaSeparatedStrings(value: string): string[] {
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

function parseTopicIds(value: string): number[] {
    const entries = parseCommaSeparatedStrings(value)
    const topicIds = entries.map((entry) => Number(entry))
    if (topicIds.some((topicId) => !Number.isSafeInteger(topicId) || topicId <= 0)) {
        throw new Error('WXPUSHER_TOPIC_IDS must be a comma-separated list of positive integers')
    }
    return [...new Set(topicIds)]
}

function readStringArraySetting(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${field} must be an array of strings`)
    }
    return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}

function readTopicIdArraySetting(value: unknown, field: string): number[] {
    if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
        throw new Error(`${field} must be an array of positive integers`)
    }
    return [...new Set(value)]
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
            wxPusherAppToken: 'default',
            wxPusherUids: 'default',
            wxPusherTopicIds: 'default',
            wxPusherNotification: 'default',
            wxPusherBackgroundOnly: 'default',
            listenHost: 'default',
            listenPort: 'default',
            publicUrl: 'default',
            corsOrigins: 'default',
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

        // wxPusherAppToken: env > file > null
        let wxPusherAppToken: string | null = null
        if (process.env.WXPUSHER_APP_TOKEN) {
            wxPusherAppToken = process.env.WXPUSHER_APP_TOKEN
            sources.wxPusherAppToken = 'env'
            if (settings.wxPusherAppToken === undefined) {
                settings.wxPusherAppToken = wxPusherAppToken
                needsSave = true
            }
        } else if (settings.wxPusherAppToken !== undefined) {
            if (typeof settings.wxPusherAppToken !== 'string') {
                throw new Error('wxPusherAppToken must be a string')
            }
            wxPusherAppToken = settings.wxPusherAppToken
            sources.wxPusherAppToken = 'file'
        }

        // wxPusherUids: env > file > []
        let wxPusherUids: string[] = []
        if (process.env.WXPUSHER_UIDS !== undefined) {
            wxPusherUids = parseCommaSeparatedStrings(process.env.WXPUSHER_UIDS)
            sources.wxPusherUids = 'env'
            if (settings.wxPusherUids === undefined) {
                settings.wxPusherUids = wxPusherUids
                needsSave = true
            }
        } else if (settings.wxPusherUids !== undefined) {
            wxPusherUids = readStringArraySetting(settings.wxPusherUids, 'wxPusherUids')
            sources.wxPusherUids = 'file'
        }

        // wxPusherTopicIds: env > file > []
        let wxPusherTopicIds: number[] = []
        if (process.env.WXPUSHER_TOPIC_IDS !== undefined) {
            wxPusherTopicIds = parseTopicIds(process.env.WXPUSHER_TOPIC_IDS)
            sources.wxPusherTopicIds = 'env'
            if (settings.wxPusherTopicIds === undefined) {
                settings.wxPusherTopicIds = wxPusherTopicIds
                needsSave = true
            }
        } else if (settings.wxPusherTopicIds !== undefined) {
            wxPusherTopicIds = readTopicIdArraySetting(settings.wxPusherTopicIds, 'wxPusherTopicIds')
            sources.wxPusherTopicIds = 'file'
        }

        // wxPusherNotification: env > file > true
        let wxPusherNotification = true
        if (process.env.WXPUSHER_NOTIFICATION !== undefined) {
            wxPusherNotification = process.env.WXPUSHER_NOTIFICATION === 'true'
            sources.wxPusherNotification = 'env'
            if (settings.wxPusherNotification === undefined) {
                settings.wxPusherNotification = wxPusherNotification
                needsSave = true
            }
        } else if (settings.wxPusherNotification !== undefined) {
            if (typeof settings.wxPusherNotification !== 'boolean') {
                throw new Error('wxPusherNotification must be a boolean')
            }
            wxPusherNotification = settings.wxPusherNotification
            sources.wxPusherNotification = 'file'
        }

        // wxPusherBackgroundOnly: env > file > false
        let wxPusherBackgroundOnly = false
        if (process.env.WXPUSHER_BACKGROUND_ONLY !== undefined) {
            wxPusherBackgroundOnly = process.env.WXPUSHER_BACKGROUND_ONLY === 'true'
            sources.wxPusherBackgroundOnly = 'env'
            if (settings.wxPusherBackgroundOnly === undefined) {
                settings.wxPusherBackgroundOnly = wxPusherBackgroundOnly
                needsSave = true
            }
        } else if (typeof settings.wxPusherBackgroundOnly === 'boolean') {
            wxPusherBackgroundOnly = settings.wxPusherBackgroundOnly
            sources.wxPusherBackgroundOnly = 'file'
        } else if (settings.wxPusherBackgroundOnly !== undefined) {
            throw new Error('wxPusherBackgroundOnly must be a boolean')
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
            publicUrl = process.env.HAPI_PUBLIC_URL
            sources.publicUrl = 'env'
            if (settings.publicUrl === undefined) {
                settings.publicUrl = publicUrl
                needsSave = true
            }
        } else if (settings.publicUrl !== undefined) {
            publicUrl = settings.publicUrl
            sources.publicUrl = 'file'
        }

        // corsOrigins: env > file > derived from publicUrl
        let corsOrigins: string[]
        if (process.env.CORS_ORIGINS) {
            corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS)
            sources.corsOrigins = 'env'
            if (settings.corsOrigins === undefined) {
                settings.corsOrigins = corsOrigins
                needsSave = true
            }
        } else if (settings.corsOrigins !== undefined) {
            corsOrigins = settings.corsOrigins
            sources.corsOrigins = 'file'
        } else {
            corsOrigins = deriveCorsOrigins(publicUrl)
        }

        // Push settings: env > file > null, env persisted on first sight —
        // one loop instead of nine copies of the per-field block above.
        const push: Record<PushSettingKey, string | null> = {
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
                    wxPusherAppToken,
                    wxPusherUids,
                    wxPusherTopicIds,
                    wxPusherNotification,
                    wxPusherBackgroundOnly,
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

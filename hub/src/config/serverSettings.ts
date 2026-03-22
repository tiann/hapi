/**
 * Hub Settings Management
 *
 * Handles loading and persistence of hub configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use
 */

import { getSettingsFile, readSettings, writeSettings } from './settings'

export interface ServerSettings {
    telegramBotToken: string | null
    telegramNotification: boolean
    feishuAppId: string | null
    feishuAppSecret: string | null
    feishuEncryptKey: string | null
    feishuVerificationToken: string | null
    feishuEnabled: boolean
    feishuNotification: boolean
    feishuBaseUrl: string
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        telegramNotification: 'env' | 'file' | 'default'
        feishuAppId: 'env' | 'file' | 'default'
        feishuAppSecret: 'env' | 'file' | 'default'
        feishuEncryptKey: 'env' | 'file' | 'default'
        feishuVerificationToken: 'env' | 'file' | 'default'
        feishuEnabled: 'env' | 'file' | 'default'
        feishuNotification: 'env' | 'file' | 'default'
        feishuBaseUrl: 'env' | 'file' | 'default'
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    }
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

/**
 * Load hub settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)

    // If settings file exists but couldn't be parsed, fail fast
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }

    let needsSave = false
    const sources: ServerSettingsResult['sources'] = {
        telegramBotToken: 'default',
        telegramNotification: 'default',
        feishuAppId: 'default',
        feishuAppSecret: 'default',
        feishuEncryptKey: 'default',
        feishuVerificationToken: 'default',
        feishuEnabled: 'default',
        feishuNotification: 'default',
        feishuBaseUrl: 'default',
        listenHost: 'default',
        listenPort: 'default',
        publicUrl: 'default',
        corsOrigins: 'default',
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

    // telegramNotification: env > file > true (default enabled for backward compatibility)
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

    // feishuAppId: env > file > null
    let feishuAppId: string | null = null
    if (process.env.FEISHU_APP_ID) {
        feishuAppId = process.env.FEISHU_APP_ID
        sources.feishuAppId = 'env'
        if (settings.feishuAppId === undefined) {
            settings.feishuAppId = feishuAppId
            needsSave = true
        }
    } else if (settings.feishuAppId !== undefined) {
        feishuAppId = settings.feishuAppId
        sources.feishuAppId = 'file'
    }

    // feishuAppSecret: env > file > null
    let feishuAppSecret: string | null = null
    if (process.env.FEISHU_APP_SECRET) {
        feishuAppSecret = process.env.FEISHU_APP_SECRET
        sources.feishuAppSecret = 'env'
        if (settings.feishuAppSecret === undefined) {
            settings.feishuAppSecret = feishuAppSecret
            needsSave = true
        }
    } else if (settings.feishuAppSecret !== undefined) {
        feishuAppSecret = settings.feishuAppSecret
        sources.feishuAppSecret = 'file'
    }

    // feishuEncryptKey: env > file > null
    let feishuEncryptKey: string | null = null
    if (process.env.FEISHU_ENCRYPT_KEY) {
        feishuEncryptKey = process.env.FEISHU_ENCRYPT_KEY
        sources.feishuEncryptKey = 'env'
        if (settings.feishuEncryptKey === undefined) {
            settings.feishuEncryptKey = feishuEncryptKey
            needsSave = true
        }
    } else if (settings.feishuEncryptKey !== undefined) {
        feishuEncryptKey = settings.feishuEncryptKey
        sources.feishuEncryptKey = 'file'
    }

    // feishuVerificationToken: env > file > null
    let feishuVerificationToken: string | null = null
    if (process.env.FEISHU_VERIFICATION_TOKEN) {
        feishuVerificationToken = process.env.FEISHU_VERIFICATION_TOKEN
        sources.feishuVerificationToken = 'env'
        if (settings.feishuVerificationToken === undefined) {
            settings.feishuVerificationToken = feishuVerificationToken
            needsSave = true
        }
    } else if (settings.feishuVerificationToken !== undefined) {
        feishuVerificationToken = settings.feishuVerificationToken
        sources.feishuVerificationToken = 'file'
    }

    // feishuEnabled: env > file > true if credentials present
    let feishuEnabled = Boolean(feishuAppId && feishuAppSecret)
    if (process.env.FEISHU_ENABLED !== undefined) {
        feishuEnabled = process.env.FEISHU_ENABLED === 'true'
        sources.feishuEnabled = 'env'
        if (settings.feishuEnabled === undefined) {
            settings.feishuEnabled = feishuEnabled
            needsSave = true
        }
    } else if (settings.feishuEnabled !== undefined) {
        feishuEnabled = settings.feishuEnabled
        sources.feishuEnabled = 'file'
    }

    // feishuNotification: env > file > true (default enabled)
    let feishuNotification = true
    if (process.env.FEISHU_NOTIFICATION !== undefined) {
        feishuNotification = process.env.FEISHU_NOTIFICATION === 'true'
        sources.feishuNotification = 'env'
        if (settings.feishuNotification === undefined) {
            settings.feishuNotification = feishuNotification
            needsSave = true
        }
    } else if (settings.feishuNotification !== undefined) {
        feishuNotification = settings.feishuNotification
        sources.feishuNotification = 'file'
    }

    // feishuBaseUrl: env > file > default (feishu.cn for CN, larksuite.com for international)
    let feishuBaseUrl = 'https://open.feishu.cn'
    if (process.env.FEISHU_BASE_URL) {
        feishuBaseUrl = process.env.FEISHU_BASE_URL
        sources.feishuBaseUrl = 'env'
        if (settings.feishuBaseUrl === undefined) {
            settings.feishuBaseUrl = feishuBaseUrl
            needsSave = true
        }
    } else if (settings.feishuBaseUrl !== undefined) {
        feishuBaseUrl = settings.feishuBaseUrl
        sources.feishuBaseUrl = 'file'
    }

    // listenHost: env > file (new or old name) > default
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
    } else if (settings.webappHost !== undefined) {
        // Migrate from old field name
        listenHost = settings.webappHost
        sources.listenHost = 'file'
        settings.listenHost = listenHost
        delete settings.webappHost
        needsSave = true
    }

    // listenPort: env > file (new or old name) > default
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
    } else if (settings.webappPort !== undefined) {
        // Migrate from old field name
        listenPort = settings.webappPort
        sources.listenPort = 'file'
        settings.listenPort = listenPort
        delete settings.webappPort
        needsSave = true
    }

    // publicUrl: env > file (new or old name) > default
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
    } else if (settings.webappUrl !== undefined) {
        // Migrate from old field name
        publicUrl = settings.webappUrl
        sources.publicUrl = 'file'
        settings.publicUrl = publicUrl
        delete settings.webappUrl
        needsSave = true
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

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            telegramBotToken,
            telegramNotification,
            feishuAppId,
            feishuAppSecret,
            feishuEncryptKey,
            feishuVerificationToken,
            feishuEnabled,
            feishuNotification,
            feishuBaseUrl,
            listenHost,
            listenPort,
            publicUrl,
            corsOrigins,
        },
        sources,
        savedToFile: needsSave,
    }
}

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
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
    barkDeviceKey: string | null
    barkServerUrl: string
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        telegramNotification: 'env' | 'file' | 'default'
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
        barkDeviceKey: 'env' | 'file' | 'default'
        barkServerUrl: 'env' | 'file' | 'default'
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
        listenHost: 'default',
        listenPort: 'default',
        publicUrl: 'default',
        corsOrigins: 'default',
        barkDeviceKey: 'default',
        barkServerUrl: 'default',
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

    // barkDeviceKey: env > file > null
    let barkDeviceKey: string | null = null
    if (process.env.BARK_DEVICE_KEY) {
        barkDeviceKey = process.env.BARK_DEVICE_KEY
        sources.barkDeviceKey = 'env'
        if (settings.barkDeviceKey === undefined) {
            settings.barkDeviceKey = barkDeviceKey
            needsSave = true
        }
    } else if (settings.barkDeviceKey !== undefined) {
        barkDeviceKey = settings.barkDeviceKey ?? null
        sources.barkDeviceKey = 'file'
    }

    // barkServerUrl: env > file > default
    let barkServerUrl = 'https://api.day.app'
    if (process.env.BARK_SERVER_URL) {
        barkServerUrl = process.env.BARK_SERVER_URL
        sources.barkServerUrl = 'env'
        if (settings.barkServerUrl === undefined) {
            settings.barkServerUrl = barkServerUrl
            needsSave = true
        }
    } else if (settings.barkServerUrl !== undefined) {
        barkServerUrl = settings.barkServerUrl
        sources.barkServerUrl = 'file'
    }

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            telegramBotToken,
            telegramNotification,
            listenHost,
            listenPort,
            publicUrl,
            corsOrigins,
            barkDeviceKey,
            barkServerUrl,
        },
        sources,
        savedToFile: needsSave,
    }
}

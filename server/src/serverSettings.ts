/**
 * Server Settings Management
 *
 * Handles loading and persistence of server configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use.
 */

import { join } from 'node:path'
import { readSettings, writeSettings, type Settings } from './web/cliApiToken'

export interface ServerSettings {
    telegramBotToken: string | null
    webappPort: number
    webappUrl: string
    corsOrigins: string[]

    // Lark (Feishu) - WIP notification-only config
    larkEnabled: boolean
    larkUseWebSocket: boolean
    larkNotifyTargets: string[]

    // Lark (Feishu) - credentials (WIP)
    larkAppId: string | null
    larkAppSecret: string | null

    // Lark (Feishu) - webhook verification token
    larkVerificationToken: string | null

    // Lark (Feishu) - URL action signing secret
    larkActionSecret: string | null
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        webappPort: 'env' | 'file' | 'default'
        webappUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'

        larkEnabled: 'env' | 'file' | 'default'
        larkUseWebSocket: 'env' | 'file' | 'default'
        larkNotifyTargets: 'env' | 'file' | 'default'

        larkAppId: 'env' | 'file' | 'default'
        larkAppSecret: 'env' | 'file' | 'default'

        larkVerificationToken: 'env' | 'file' | 'default'
        larkActionSecret: 'env' | 'file' | 'default'
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

function parseStringList(str: string): string[] {
    return str
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
}

function parseBoolean(str: string): boolean {
    const v = str.trim().toLowerCase()
    return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on'
}

/**
 * Derive CORS origins from webapp URL
 */
function deriveCorsOrigins(webappUrl: string): string[] {
    try {
        return [new URL(webappUrl).origin]
    } catch {
        return []
    }
}

/**
 * Load server settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = join(dataDir, 'settings.json')
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
        webappPort: 'default',
        webappUrl: 'default',
        corsOrigins: 'default',

        larkEnabled: 'default',
        larkUseWebSocket: 'default',
        larkNotifyTargets: 'default',

        larkAppId: 'default',
        larkAppSecret: 'default',

        larkVerificationToken: 'default',
        larkActionSecret: 'default',
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

    // webappPort: env > file > 3006
    let webappPort = 3006
    if (process.env.WEBAPP_PORT) {
        const parsed = parseInt(process.env.WEBAPP_PORT, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('WEBAPP_PORT must be a valid port number')
        }
        webappPort = parsed
        sources.webappPort = 'env'
        if (settings.webappPort === undefined) {
            settings.webappPort = webappPort
            needsSave = true
        }
    } else if (settings.webappPort !== undefined) {
        webappPort = settings.webappPort
        sources.webappPort = 'file'
    }

    // webappUrl: env > file > http://localhost:{port}
    let webappUrl = `http://localhost:${webappPort}`
    if (process.env.WEBAPP_URL) {
        webappUrl = process.env.WEBAPP_URL
        sources.webappUrl = 'env'
        if (settings.webappUrl === undefined) {
            settings.webappUrl = webappUrl
            needsSave = true
        }
    } else if (settings.webappUrl !== undefined) {
        webappUrl = settings.webappUrl
        sources.webappUrl = 'file'
    }

    // corsOrigins: env > file > derived from webappUrl
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
        corsOrigins = deriveCorsOrigins(webappUrl)
    }

    // larkEnabled: env > file > false
    let larkEnabled = false
    if (process.env.LARK_ENABLED) {
        larkEnabled = parseBoolean(process.env.LARK_ENABLED)
        sources.larkEnabled = 'env'
        if (settings.larkEnabled === undefined) {
            settings.larkEnabled = larkEnabled
            needsSave = true
        }
    } else if (settings.larkEnabled !== undefined) {
        larkEnabled = Boolean(settings.larkEnabled)
        sources.larkEnabled = 'file'
    }

    // larkUseWebSocket: env > file > false
    let larkUseWebSocket = false
    if (process.env.LARK_USE_WEBSOCKET) {
        larkUseWebSocket = parseBoolean(process.env.LARK_USE_WEBSOCKET)
        sources.larkUseWebSocket = 'env'
        if (settings.larkUseWebSocket === undefined) {
            settings.larkUseWebSocket = larkUseWebSocket
            needsSave = true
        }
    } else if (settings.larkUseWebSocket !== undefined) {
        larkUseWebSocket = Boolean(settings.larkUseWebSocket)
        sources.larkUseWebSocket = 'file'
    }

    // larkNotifyTargets: env > file > []
    let larkNotifyTargets: string[] = []
    if (process.env.LARK_NOTIFY_TARGETS) {
        larkNotifyTargets = parseStringList(process.env.LARK_NOTIFY_TARGETS)
        sources.larkNotifyTargets = 'env'
        if (settings.larkNotifyTargets === undefined) {
            settings.larkNotifyTargets = larkNotifyTargets
            needsSave = true
        }
    } else if (settings.larkNotifyTargets !== undefined) {
        larkNotifyTargets = Array.isArray(settings.larkNotifyTargets)
            ? settings.larkNotifyTargets.filter((x) => typeof x === 'string')
            : []
        sources.larkNotifyTargets = 'file'
    }

    // larkAppId: env(APP_ID) > file > null
    let larkAppId: string | null = null
    if (process.env.APP_ID) {
        larkAppId = process.env.APP_ID
        sources.larkAppId = 'env'
        if (settings.larkAppId === undefined) {
            settings.larkAppId = larkAppId
            needsSave = true
        }
    } else if (settings.larkAppId !== undefined) {
        larkAppId = settings.larkAppId ?? null
        sources.larkAppId = 'file'
    }

    // larkAppSecret: env(APP_SECRET) > file > null
    let larkAppSecret: string | null = null
    if (process.env.APP_SECRET) {
        larkAppSecret = process.env.APP_SECRET
        sources.larkAppSecret = 'env'
        if (settings.larkAppSecret === undefined) {
            settings.larkAppSecret = larkAppSecret
            needsSave = true
        }
    } else if (settings.larkAppSecret !== undefined) {
        larkAppSecret = settings.larkAppSecret ?? null
        sources.larkAppSecret = 'file'
    }

    // larkVerificationToken: env(LARK_VERIFICATION_TOKEN) > file > null
    let larkVerificationToken: string | null = null
    if (process.env.LARK_VERIFICATION_TOKEN) {
        larkVerificationToken = process.env.LARK_VERIFICATION_TOKEN
        sources.larkVerificationToken = 'env'
        if (settings.larkVerificationToken === undefined) {
            settings.larkVerificationToken = larkVerificationToken
            needsSave = true
        }
    } else if (settings.larkVerificationToken !== undefined) {
        larkVerificationToken = settings.larkVerificationToken ?? null
        sources.larkVerificationToken = 'file'
    }

    // larkActionSecret: env(LARK_ACTION_SECRET) > file > null
    let larkActionSecret: string | null = null
    if (process.env.LARK_ACTION_SECRET) {
        larkActionSecret = process.env.LARK_ACTION_SECRET
        sources.larkActionSecret = 'env'
        if (settings.larkActionSecret === undefined) {
            settings.larkActionSecret = larkActionSecret
            needsSave = true
        }
    } else if (settings.larkActionSecret !== undefined) {
        larkActionSecret = settings.larkActionSecret ?? null
        sources.larkActionSecret = 'file'
    }

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            telegramBotToken,
            webappPort,
            webappUrl,
            corsOrigins,

            larkEnabled,
            larkUseWebSocket,
            larkNotifyTargets,

            larkAppId,
            larkAppSecret,

            larkVerificationToken,
            larkActionSecret,
        },
        sources,
        savedToFile: needsSave,
    }
}

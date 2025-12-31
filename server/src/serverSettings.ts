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
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        webappPort: 'env' | 'file' | 'default'
        webappUrl: 'env' | 'file' | 'default'
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
        },
        sources,
        savedToFile: needsSave,
    }
}

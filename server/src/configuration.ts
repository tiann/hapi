/**
 * Configuration for hapi-server (Direct Connect)
 *
 * Configuration is loaded with priority: environment variable > settings.json > default
 * When values are read from environment variables and not present in settings.json,
 * they are automatically saved for future use
 *
 * Optional environment variables:
 * - CLI_API_TOKEN: Shared secret for hapi CLI authentication (auto-generated if not set)
 * - TELEGRAM_BOT_TOKEN: Telegram Bot API token from @BotFather
 * - TELEGRAM_NOTIFICATION: Enable/disable Telegram notifications (default: true)
 * - WEBAPP_PORT: Port for Mini App HTTP server (default: 3006)
 * - WEBAPP_URL: Public URL for Telegram Mini App
 * - CORS_ORIGINS: Comma-separated CORS origins
 * - HAPI_RELAY_API: Relay API domain for tunwg (default: relay.hapi.run)
 * - HAPI_RELAY_AUTH: Relay auth key for tunwg (default: hapi)
 * - HAPI_RELAY_FORCE_TCP: Force TCP relay mode when UDP is unavailable (true/1)
 * - VAPID_SUBJECT: Contact email or URL for Web Push (defaults to mailto:admin@hapi.run)
 * - HAPI_HOME: Data directory (default: ~/.hapi)
 * - DB_PATH: SQLite database path (default: {HAPI_HOME}/hapi.db)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateCliApiToken } from './config/cliApiToken'
import { getSettingsFile } from './config/settings'
import { loadServerSettings, type ServerSettings, type ServerSettingsResult } from './config/serverSettings'

export type ConfigSource = 'env' | 'file' | 'default'

export interface ConfigSources {
    telegramBotToken: ConfigSource
    telegramNotification: ConfigSource
    webappHost: ConfigSource
    webappPort: ConfigSource
    webappUrl: ConfigSource
    corsOrigins: ConfigSource
    cliApiToken: 'env' | 'file' | 'generated'
}

class Configuration {
    /** Telegram Bot API token */
    public readonly telegramBotToken: string | null

    /** Telegram bot enabled status (token present) */
    public readonly telegramEnabled: boolean

    /** Telegram notifications enabled */
    public readonly telegramNotification: boolean

    /** CLI auth token (shared secret) */
    public cliApiToken: string

    /** Source of CLI API token */
    public cliApiTokenSource: 'env' | 'file' | 'generated' | ''

    /** Whether CLI API token was newly generated (for first-run display) */
    public cliApiTokenIsNew: boolean

    /** Path to settings.json file */
    public readonly settingsFile: string

    /** Data directory for credentials and state */
    public readonly dataDir: string

    /** SQLite DB path */
    public readonly dbPath: string

    /** Port for the Mini App HTTP server */
    public readonly webappPort: number

    /** Host/IP to bind the Mini App HTTP server to */
    public readonly webappHost: string

    /** Public HTTPS URL for the Telegram Mini App (used in WebApp buttons) */
    public readonly miniAppUrl: string

    /** Allowed CORS origins for Mini App + Socket.IO (comma-separated env override) */
    public readonly corsOrigins: string[]

    /** Sources of each configuration value */
    public readonly sources: ConfigSources

    /** Private constructor - use createConfiguration() instead */
    private constructor(
        dataDir: string,
        dbPath: string,
        serverSettings: ServerSettings,
        sources: ServerSettingsResult['sources']
    ) {
        this.dataDir = dataDir
        this.dbPath = dbPath
        this.settingsFile = getSettingsFile(dataDir)

        // Apply server settings
        this.telegramBotToken = serverSettings.telegramBotToken
        this.telegramEnabled = Boolean(this.telegramBotToken)
        this.telegramNotification = serverSettings.telegramNotification
        this.webappHost = serverSettings.webappHost
        this.webappPort = serverSettings.webappPort
        this.miniAppUrl = serverSettings.webappUrl
        this.corsOrigins = serverSettings.corsOrigins

        // CLI API token - will be set by _setCliApiToken() before create() returns
        this.cliApiToken = ''
        this.cliApiTokenSource = ''
        this.cliApiTokenIsNew = false

        // Store sources for logging (cliApiToken will be set by _setCliApiToken)
        this.sources = {
            ...sources,
        } as ConfigSources

        // Ensure data directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }
    }

    /** Create configuration asynchronously */
    static async create(): Promise<Configuration> {
        // 1. Determine data directory (env only - not persisted)
        const dataDir = process.env.HAPI_HOME
            ? process.env.HAPI_HOME.replace(/^~/, homedir())
            : join(homedir(), '.hapi')

        // Ensure data directory exists before loading settings
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true })
        }

        // 2. Determine DB path (env only - not persisted)
        const dbPath = process.env.DB_PATH
            ? process.env.DB_PATH.replace(/^~/, homedir())
            : join(dataDir, 'hapi.db')

        // 3. Load server settings (with persistence)
        const settingsResult = await loadServerSettings(dataDir)

        if (settingsResult.savedToFile) {
            console.log(`[Server] Configuration saved to ${getSettingsFile(dataDir)}`)
        }

        // 4. Create configuration instance
        const config = new Configuration(
            dataDir,
            dbPath,
            settingsResult.settings,
            settingsResult.sources
        )

        // 5. Load CLI API token
        const tokenResult = await getOrCreateCliApiToken(dataDir)
        config._setCliApiToken(tokenResult.token, tokenResult.source, tokenResult.isNew)

        return config
    }

    /** Set CLI API token (called during async initialization) */
    _setCliApiToken(token: string, source: 'env' | 'file' | 'generated', isNew: boolean): void {
        this.cliApiToken = token
        this.cliApiTokenSource = source
        this.cliApiTokenIsNew = isNew
        ;(this.sources as { cliApiToken: string }).cliApiToken = source
    }
}

// Singleton instance (set by createConfiguration)
let _configuration: Configuration | null = null

/**
 * Create and initialize configuration asynchronously.
 * Must be called once at startup before getConfiguration() can be used.
 */
export async function createConfiguration(): Promise<Configuration> {
    if (_configuration) {
        return _configuration
    }
    _configuration = await Configuration.create()
    return _configuration
}

/**
 * Get the initialized configuration.
 * Throws if createConfiguration() has not been called yet.
 */
export function getConfiguration(): Configuration {
    if (!_configuration) {
        throw new Error('Configuration not initialized. Call createConfiguration() first.')
    }
    return _configuration
}

// For compatibility - throws on access if not configured
export const configuration = new Proxy({} as Configuration, {
    get(_, prop) {
        return getConfiguration()[prop as keyof Configuration]
    }
})

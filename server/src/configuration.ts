/**
 * Configuration for hapi-server (Direct Connect)
 *
 * Required environment variables:
 * - TELEGRAM_BOT_TOKEN: Telegram Bot API token from @BotFather
 * - ALLOWED_CHAT_IDS: Comma-separated list of allowed Telegram chat IDs
 * - CLI_API_TOKEN: Shared secret for hapi CLI authentication
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

class Configuration {
    /** Telegram Bot API token */
    public readonly telegramBotToken: string

    /** List of allowed Telegram chat IDs (security whitelist) */
    public readonly allowedChatIds: number[]

    /** CLI auth token (shared secret) */
    public readonly cliApiToken: string

    /** Data directory for credentials and state */
    public readonly dataDir: string

    /** SQLite DB path */
    public readonly dbPath: string

    /** Port for the Mini App HTTP server */
    public readonly webappPort: number

    /** Public HTTPS URL for the Telegram Mini App (used in WebApp buttons) */
    public readonly miniAppUrl: string

    /** Allowed CORS origins for Mini App + Socket.IO (comma-separated env override) */
    public readonly corsOrigins: string[]

    constructor() {
        // Required: Telegram Bot Token
        const botToken = process.env.TELEGRAM_BOT_TOKEN
        if (!botToken) {
            throw new Error('TELEGRAM_BOT_TOKEN environment variable is required')
        }
        this.telegramBotToken = botToken

        // Required: Allowed Chat IDs
        const chatIdsStr = process.env.ALLOWED_CHAT_IDS
        if (!chatIdsStr) {
            throw new Error('ALLOWED_CHAT_IDS environment variable is required (comma-separated list)')
        }
        this.allowedChatIds = chatIdsStr
            .split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id))

        if (this.allowedChatIds.length === 0) {
            throw new Error('ALLOWED_CHAT_IDS must contain at least one valid chat ID')
        }

        // Required: CLI API token (shared secret)
        const cliApiToken = process.env.CLI_API_TOKEN
        if (!cliApiToken) {
            throw new Error('CLI_API_TOKEN environment variable is required')
        }
        this.cliApiToken = cliApiToken

        // Mini App web server configuration
        const webappPortRaw = process.env.WEBAPP_PORT
        const parsedWebappPort = webappPortRaw ? parseInt(webappPortRaw, 10) : 3006
        if (!Number.isFinite(parsedWebappPort) || parsedWebappPort <= 0) {
            throw new Error('WEBAPP_PORT must be a valid port number')
        }
        this.webappPort = parsedWebappPort

        // For production, Telegram requires HTTPS for Mini Apps.
        // This URL is what Telegram clients will open when pressing the WebApp button.
        this.miniAppUrl = process.env.WEBAPP_URL || `http://localhost:${this.webappPort}`

        // CORS origin allowlist (Mini App + Socket.IO browser clients).
        // - Defaults to the Mini App's origin (derived from WEBAPP_URL).
        // - If set to "*", allows all origins (not recommended for internet-exposed deployments).
        const corsOriginsRaw = process.env.CORS_ORIGINS
        if (corsOriginsRaw) {
            const entries = corsOriginsRaw
                .split(',')
                .map((origin) => origin.trim())
                .filter(Boolean)

            if (entries.includes('*')) {
                this.corsOrigins = ['*']
            } else {
                const normalized: string[] = []
                for (const entry of entries) {
                    try {
                        normalized.push(new URL(entry).origin)
                    } catch {
                        // Keep raw value if it's already an origin-like string.
                        normalized.push(entry)
                    }
                }
                this.corsOrigins = normalized
            }
        } else {
            try {
                this.corsOrigins = [new URL(this.miniAppUrl).origin]
            } catch {
                this.corsOrigins = []
            }
        }

        // Data directory
        if (process.env.HAPI_BOT_DATA_DIR) {
            const expandedPath = process.env.HAPI_BOT_DATA_DIR.replace(/^~/, homedir())
            this.dataDir = expandedPath
        } else {
            this.dataDir = join(homedir(), '.hapi-server')
        }

        // DB path (defaults inside dataDir)
        if (process.env.DB_PATH) {
            const expandedPath = process.env.DB_PATH.replace(/^~/, homedir())
            this.dbPath = expandedPath
        } else {
            this.dbPath = join(this.dataDir, 'hapi.db')
        }

        // Ensure data directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }
    }

    /** Check if a chat ID is allowed */
    isChatIdAllowed(chatId: number): boolean {
        return this.allowedChatIds.includes(chatId)
    }
}

// Lazy initialization to allow configuration to fail gracefully
let _configuration: Configuration | null = null

export function getConfiguration(): Configuration {
    if (!_configuration) {
        _configuration = new Configuration()
    }
    return _configuration
}

// For compatibility - throws on access if not configured
export const configuration = new Proxy({} as Configuration, {
    get(_, prop) {
        return getConfiguration()[prop as keyof Configuration]
    }
})

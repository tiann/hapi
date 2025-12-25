/**
 * CLI API Token management
 *
 * Handles automatic generation and persistence of CLI_API_TOKEN.
 * Priority: environment variable > settings.json > auto-generate
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

export interface Settings {
    onboardingCompleted?: boolean
    machineId?: string
    machineIdConfirmedByServer?: boolean
    daemonAutoStartWhenRunningHappy?: boolean
    cliApiToken?: string
    // Server configuration (persisted from environment variables)
    telegramBotToken?: string
    allowedChatIds?: number[]
    webappPort?: number
    webappUrl?: string
    corsOrigins?: string[]
}

export interface CliApiTokenResult {
    token: string
    source: 'env' | 'file' | 'generated'
    isNew: boolean
    filePath: string
}

/**
 * Generate a cryptographically secure random token
 * 32 bytes = 256 bits, base64url encoded = ~43 characters
 */
function generateSecureToken(): string {
    return randomBytes(32).toString('base64url')
}

/**
 * Check if a token appears to be weak
 * Only applies to user-provided tokens (environment variable)
 */
function isWeakToken(token: string): boolean {
    if (token.length < 16) return true

    // Detect common weak patterns
    const weakPatterns = [
        /^[0-9]+$/,                              // Pure numbers
        /^(.)\1+$/,                              // Repeated character
        /^(abc|123|password|secret|token)/i,    // Common prefixes
    ]
    return weakPatterns.some(p => p.test(token))
}

/**
 * Read settings from file, preserving all existing fields.
 * Returns null if file exists but cannot be parsed (to avoid data loss).
 */
export async function readSettings(settingsFile: string): Promise<Settings | null> {
    if (!existsSync(settingsFile)) {
        return {}
    }
    try {
        const content = await readFile(settingsFile, 'utf8')
        return JSON.parse(content)
    } catch (error) {
        // Return null to signal parse error - caller should not overwrite
        console.error(`[WARN] Failed to parse ${settingsFile}: ${error}`)
        return null
    }
}

/**
 * Write settings to file atomically (temp file + rename)
 */
export async function writeSettings(settingsFile: string, settings: Settings): Promise<void> {
    const dir = dirname(settingsFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }

    const tmpFile = settingsFile + '.tmp'
    await writeFile(tmpFile, JSON.stringify(settings, null, 2))
    await rename(tmpFile, settingsFile)
}

/**
 * Get or create CLI API token
 *
 * Priority:
 * 1. CLI_API_TOKEN environment variable (highest - backward compatible)
 * 2. settings.json cliApiToken field
 * 3. Auto-generate and save to settings.json
 */
export async function getOrCreateCliApiToken(dataDir: string): Promise<CliApiTokenResult> {
    const settingsFile = join(dataDir, 'settings.json')

    // 1. Environment variable has highest priority (backward compatible)
    const envToken = process.env.CLI_API_TOKEN
    if (envToken) {
        if (isWeakToken(envToken)) {
            console.warn('[WARN] CLI_API_TOKEN appears to be weak. Consider using a stronger secret.')
        }

        // Persist env token to file if not already saved (prevents token loss on env var issues)
        const settings = await readSettings(settingsFile)
        if (settings !== null && !settings.cliApiToken) {
            settings.cliApiToken = envToken
            await writeSettings(settingsFile, settings)
        }

        return { token: envToken, source: 'env', isNew: false, filePath: settingsFile }
    }

    // 2. Read from settings file
    const settings = await readSettings(settingsFile)

    // If settings file exists but couldn't be parsed, fail fast to avoid data loss
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }

    if (settings.cliApiToken) {
        return { token: settings.cliApiToken, source: 'file', isNew: false, filePath: settingsFile }
    }

    // 3. Generate new token and save
    const newToken = generateSecureToken()
    settings.cliApiToken = newToken
    await writeSettings(settingsFile, settings)

    return { token: newToken, source: 'generated', isNew: true, filePath: settingsFile }
}

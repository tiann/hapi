/**
 * CLI API Token management
 *
 * Handles automatic generation and persistence of CLI_API_TOKEN.
 * Priority: environment variable > settings.json > auto-generate
 */

import { randomBytes } from 'node:crypto'
import { getOrCreateSettingsValue } from './generators'
import { getSettingsFile, readSettings, writeSettings } from './settings'

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

function normalizeCliApiToken(rawToken: string, source: 'env' | 'file'): { token: string; didTrim: boolean } {
    const token = rawToken.trim()
    if (!token) {
        throw new Error(`CLI_API_TOKEN from ${source} must not be empty`)
    }
    if (token !== rawToken) {
        console.warn(`[WARN] CLI_API_TOKEN from ${source} contained surrounding whitespace; trimming it.`)
    }
    return { token, didTrim: token !== rawToken }
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
    const settingsFile = getSettingsFile(dataDir)

    // 1. Environment variable has highest priority (backward compatible)
    const envToken = process.env.CLI_API_TOKEN
    if (envToken) {
        const normalized = normalizeCliApiToken(envToken, 'env')
        if (isWeakToken(normalized.token)) {
            console.warn('[WARN] CLI_API_TOKEN appears to be weak. Consider using a stronger secret.')
        }

        // Persist env token to file if not already saved (prevents token loss on env var issues)
        const settings = await readSettings(settingsFile)
        if (settings !== null && !settings.cliApiToken) {
            settings.cliApiToken = normalized.token
            await writeSettings(settingsFile, settings)
        }

        return { token: normalized.token, source: 'env', isNew: false, filePath: settingsFile }
    }

    const result = await getOrCreateSettingsValue({
        settingsFile,
        readValue: (settings) => {
            if (!settings.cliApiToken) {
                return null
            }
            const normalized = normalizeCliApiToken(settings.cliApiToken, 'file')
            if (normalized.didTrim) {
                settings.cliApiToken = normalized.token
                return { value: normalized.token, writeBack: true }
            }
            return { value: normalized.token }
        },
        writeValue: (settings, value) => {
            settings.cliApiToken = value
        },
        generate: generateSecureToken
    })

    return {
        token: result.value,
        source: result.created ? 'generated' : 'file',
        isNew: result.created,
        filePath: settingsFile
    }
}

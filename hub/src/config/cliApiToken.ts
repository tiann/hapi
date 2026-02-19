/**
 * CLI API Token management
 *
 * Handles automatic generation and persistence of CLI_API_TOKEN.
 * Priority: environment variable > settings.json > auto-generate
 */

import { randomBytes } from 'node:crypto'
import { parseAccessToken } from '../utils/accessToken'
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

type CliApiTokenSource = 'env' | 'file'

function normalizeCliApiToken(rawToken: string, source: CliApiTokenSource): { token: string; didStrip: boolean } {
    const parsed = parseAccessToken(rawToken)
    if (!parsed) {
        if (rawToken.includes(':')) {
            console.warn(`[WARN] CLI_API_TOKEN from ${source} contains ":" but is not a valid token. Server expects a base token without namespace.`)
        }
        return { token: rawToken, didStrip: false }
    }

    if (!rawToken.includes(':')) {
        return { token: rawToken, didStrip: false }
    }

    console.warn(
        `[WARN] CLI_API_TOKEN from ${source} includes namespace suffix "${parsed.namespace}". ` +
        'Server expects the base token only; stripping the suffix.'
    )
    return { token: parsed.baseToken, didStrip: true }
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
            throw new Error('[ERROR] CLI_API_TOKEN is too weak. It must be at least 16 characters long and not follow common weak patterns. Please use a stronger secret.')
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
            if (isWeakToken(normalized.token)) {
                throw new Error('[ERROR] Saved CLI API token in settings.json is too weak. It must be at least 16 characters long. Please update it or delete the field to auto-generate a new one.')
            }
            if (normalized.didStrip) {
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

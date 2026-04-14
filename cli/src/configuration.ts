/**
 * Global configuration for HAPI CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'
import { getCliArgs } from '@/utils/cliArgs'

export function parseExtraHeaders(raw: string | undefined, warn: (message: string) => void = console.warn): Record<string, string> {
    if (!raw) {
        return {}
    }

    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            warn('[WARN] HAPI_EXTRA_HEADERS_JSON must be a JSON object. Ignoring value.')
            return {}
        }

        const entries = Object.entries(parsed)
        const headers = Object.fromEntries(
            entries.filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
        )

        if (Object.keys(headers).length !== entries.length) {
            warn('[WARN] HAPI_EXTRA_HEADERS_JSON only supports string header values. Ignoring non-string entries.')
        }

        return headers
    } catch {
        warn('[WARN] Failed to parse HAPI_EXTRA_HEADERS_JSON. Ignoring value.')
        return {}
    }
}

class Configuration {
    private _apiUrl: string
    private _cliApiToken: string
    private _extraHeaders: Record<string, string>
    public readonly isRunnerProcess: boolean

    // Directories and paths (from persistence)
    public readonly happyHomeDir: string
    public readonly logsDir: string
    public readonly settingsFile: string
    public readonly privateKeyFile: string
    public readonly runnerStateFile: string
    public readonly runnerLockFile: string
    public readonly currentCliVersion: string

    public readonly isExperimentalEnabled: boolean

    constructor() {
        // Server configuration
        this._apiUrl = process.env.HAPI_API_URL || 'http://localhost:3006'
        this._cliApiToken = process.env.CLI_API_TOKEN || ''
        this._extraHeaders = parseExtraHeaders(process.env.HAPI_EXTRA_HEADERS_JSON)

        // Check if we're running as runner based on process args
        const args = getCliArgs()
        this.isRunnerProcess = args.length >= 2 && args[0] === 'runner' && (args[1] === 'start-sync')

        // Directory configuration - Priority: HAPI_HOME env > default home dir
        if (process.env.HAPI_HOME) {
            // Expand ~ to home directory if present
            const expandedPath = process.env.HAPI_HOME.replace(/^~/, homedir())
            this.happyHomeDir = expandedPath
        } else {
            this.happyHomeDir = join(homedir(), '.hapi')
        }

        this.logsDir = join(this.happyHomeDir, 'logs')
        this.settingsFile = join(this.happyHomeDir, 'settings.json')
        this.privateKeyFile = join(this.happyHomeDir, 'access.key')
        this.runnerStateFile = join(this.happyHomeDir, 'runner.state.json')
        this.runnerLockFile = join(this.happyHomeDir, 'runner.state.json.lock')

        this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPI_EXPERIMENTAL?.toLowerCase() || '')

        this.currentCliVersion = packageJson.version

        if (!existsSync(this.happyHomeDir)) {
            mkdirSync(this.happyHomeDir, { recursive: true })
        }
        // Ensure directories exist
        if (!existsSync(this.logsDir)) {
            mkdirSync(this.logsDir, { recursive: true })
        }
    }

    get apiUrl(): string {
        return this._apiUrl
    }

    _setApiUrl(url: string): void {
        this._apiUrl = url
    }

    get cliApiToken(): string {
        return this._cliApiToken
    }

    _setCliApiToken(token: string): void {
        this._cliApiToken = token
    }

    get extraHeaders(): Record<string, string> {
        return this._extraHeaders
    }

    _setExtraHeaders(headers: Record<string, string>): void {
        this._extraHeaders = { ...headers }
    }
}

export const configuration: Configuration = new Configuration()

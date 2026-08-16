import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'

export interface Settings {
    machineId?: string
    machineIdConfirmedByServer?: boolean
    runnerAutoStartWhenRunningHappy?: boolean
    cliApiToken?: string
    vapidKeys?: {
        publicKey: string
        privateKey: string
    }
    // Server configuration (persisted from environment variables)
    telegramBotToken?: string
    telegramNotification?: boolean
    serverChanSendKey?: string
    serverChanNotification?: boolean
    serverChanBackgroundOnly?: boolean
    listenHost?: string
    listenPort?: number
    publicUrl?: string
    corsOrigins?: string[]
    /** Per-hub relay auth key issued by the relay server (/issue) */
    relayAuthKey?: string
    /**
     * When true, CLI injects the AGENT_NOTIFY_SUMMARY trailing-line contract
     * into supported flavor system / developer instructions. Default off.
     */
    sessionSummaryContract?: boolean
    /**
     * When true, web chat shows a compact AGENT_NOTIFY_SUMMARY row.
     * Default off: render/copy strip the footer; store stays raw.
     */
    sessionSummaryInChat?: boolean
    /**
     * Hub-side provider API keys / endpoints managed from Settings.
     * Env vars still win when set at process start (ops override).
     */
    providerCredentials?: Partial<Record<string, string>>
}

export function getSettingsFile(dataDir: string): string {
    return join(dataDir, 'settings.json')
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

export async function readSettingsOrThrow(settingsFile: string): Promise<Settings> {
    const settings = await readSettings(settingsFile)
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }
    return settings
}

/** Per-file in-process promise chain (hub concurrent requests). */
const settingsUpdateChains = new Map<string, Promise<unknown>>()

async function withInProcessSettingsLock<T>(
    settingsFile: string,
    work: () => Promise<T>
): Promise<T> {
    const previous = settingsUpdateChains.get(settingsFile) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    settingsUpdateChains.set(settingsFile, run.then(() => undefined, () => undefined))
    return run
}

/**
 * Serialize against in-process writers and the CLI's cross-process `.lock` file.
 */
export async function withSettingsLock<T>(
    settingsFile: string,
    work: () => Promise<T>
): Promise<T> {
    return withInProcessSettingsLock(settingsFile, () => withSettingsFileLock(settingsFile, work))
}

/**
 * Atomic write without taking the settings lock.
 * Callers must already hold `withSettingsLock` for `settingsFile`.
 * Unique temp path + owner-only modes (Codex #1376 / #1392).
 */
async function writeSettingsUnlocked(settingsFile: string, settings: Settings): Promise<void> {
    const dir = dirname(settingsFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }
    await chmod(dir, 0o700).catch(() => {})

    const tmpFile = join(dir, `.settings.${randomUUID()}.tmp`)
    try {
        await writeFile(tmpFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
        await chmod(tmpFile, 0o600).catch(() => {})
        await rename(tmpFile, settingsFile)
        await chmod(settingsFile, 0o600).catch(() => {})
    } catch (error) {
        await unlink(tmpFile).catch(() => {})
        throw error
    }
}

/**
 * Write settings to file atomically (unique temp file + rename).
 * Owner-only modes: settings may hold provider API keys and bot tokens.
 * Serialized against every other settings writer for this file.
 */
export async function writeSettings(settingsFile: string, settings: Settings): Promise<void> {
    return withSettingsLock(settingsFile, () => writeSettingsUnlocked(settingsFile, settings))
}

export type SettingsUpdateOutcome<T> = {
    settings: Settings
    result: T
    afterCommit?: () => void
    /** When false, skip persisting (lock still held for a consistent read). Default true. */
    write?: boolean
}

/**
 * Serialized read-modify-write for settings.json.
 * Prefer this over unlocked read + `writeSettings` for any runtime mutation.
 */
export async function updateSettings<T>(
    settingsFile: string,
    mutate: (settings: Settings) => SettingsUpdateOutcome<T> | Promise<SettingsUpdateOutcome<T>>
): Promise<T> {
    return withSettingsLock(settingsFile, async () => {
        const current = await readSettingsOrThrow(settingsFile)
        const outcome = await mutate(current)
        if (outcome.write !== false) {
            await writeSettingsUnlocked(settingsFile, outcome.settings)
        }
        outcome.afterCommit?.()
        return outcome.result
    })
}

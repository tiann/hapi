import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

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

async function writeSettingsAtomic(settingsFile: string, settings: Settings): Promise<void> {
    const dir = dirname(settingsFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }

    // Unique temp path so concurrent writers cannot clobber each other's
    // staging file before rename (Codex #1376 Major).
    const tmpFile = join(dir, `.settings.${randomUUID()}.tmp`)
    try {
        await writeFile(tmpFile, JSON.stringify(settings, null, 2))
        await rename(tmpFile, settingsFile)
    } catch (error) {
        await unlink(tmpFile).catch(() => {})
        throw error
    }
}

/**
 * Write settings to file atomically (unique temp file + rename).
 * Prefer {@link updateSettings} for read-modify-write so concurrent writers
 * serialize via the shared lock file.
 */
export async function writeSettings(settingsFile: string, settings: Settings): Promise<void> {
    await writeSettingsAtomic(settingsFile, settings)
}

/**
 * Atomically update settings with multi-process safety via file locking.
 * Lock path matches CLI (`${settingsFile}.lock`) so hub and CLI serialize
 * when they share the same ~/.hapi/settings.json.
 */
export async function updateSettings(
    settingsFile: string,
    updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
    const LOCK_RETRY_INTERVAL_MS = 100
    const MAX_LOCK_ATTEMPTS = 50
    const STALE_LOCK_TIMEOUT_MS = 10_000

    const dir = dirname(settingsFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }

    const lockFile = `${settingsFile}.lock`
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined
    let attempts = 0

    while (attempts < MAX_LOCK_ATTEMPTS) {
        try {
            // 'wx' = create exclusively, fail if exists (cross-platform)
            fileHandle = await open(lockFile, 'wx')
            break
        } catch (err: unknown) {
            const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined
            if (code === 'EEXIST') {
                attempts++
                await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS))
                try {
                    const stats = await stat(lockFile)
                    if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
                        await unlink(lockFile).catch(() => {})
                    }
                } catch {
                    // ignore stale-check races
                }
            } else {
                throw err
            }
        }
    }

    if (!fileHandle) {
        throw new Error(
            `Failed to acquire settings lock after ${(MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS) / 1000} seconds`
        )
    }

    try {
        const current = await readSettingsOrThrow(settingsFile)
        const updated = await updater(current)
        await writeSettingsAtomic(settingsFile, updated)
        return updated
    } finally {
        await fileHandle.close()
        await unlink(lockFile).catch(() => {})
    }
}

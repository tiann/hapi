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
    // Push delivery (FCM + iOS/APNs) — persisted from env like the rest of
    // this section; interpreted by fcmConfig.ts / iosPushConfig.ts.
    androidPushMode?: string
    fcmServiceAccountPath?: string
    iosPushMode?: string
    iosPushRelayUrl?: string
    apnsKeyP8Path?: string
    apnsKeyId?: string
    apnsTeamId?: string
    apnsBundleId?: string
    apnsEnv?: string
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
     * When true, CLI swaps the injected change_title steer from
     * "use sparingly" to "rewrite the session title at the end of every
     * user turn". Default off.
     */
    autoTitlePerTurn?: boolean
    /**
     * Hub-side provider API keys / endpoints managed from Settings.
     * Env vars still win when set at process start (ops override).
     */
    providerCredentials?: Partial<Record<string, string>>
    /**
     * Cap (seconds) on one ElevenLabs ConvAI conversation. Env
     * ELEVENLABS_MAX_DURATION_SECONDS still wins when set at process start.
     */
    elevenLabsMaxDurationSeconds?: number
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
    return settingsOrUnreadable(settings, settingsFile)
}

function settingsOrUnreadable(settings: Settings | null, settingsFile: string): Settings {
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }
    return settings
}

/**
 * Per-request settings reads (session bootstrap POST/GET /cli/sessions,
 * settings GET, voice credential status) used to hit the disk on every
 * call: each flag helper re-reads the whole settings.json, so a
 * 15-session reconnect fan-out queued ~45 file reads on the single hub
 * event loop — during engine long turns those trivial probes measured
 * 1-9s. The cached reader serves in-memory snapshots instead:
 *
 * - fresh (within TTL)     -> memory hit, zero disk I/O
 * - stale (past TTL)       -> stale snapshot returned immediately plus ONE
 *                             single-flight background revalidation
 * - cold (no snapshot yet) -> await the shared in-flight read
 * - writes (this process)  -> write-through refresh from the
 *                             writeSettingsUnlocked funnel; a generation
 *                             counter keeps a late-landing revalidation
 *                             (stale inode) from stomping the newer value
 *
 * updateSettings / writeSettings still read authoritatively under the
 * lock; only hot read paths use the cache. External hand-edits of
 * settings.json converge within the TTL.
 */
export interface SettingsReadCache {
    read(settingsFile: string): Promise<Settings | null>
    refreshAfterWrite(settingsFile: string, settings: Settings): void
    clear(): void
}

interface SettingsCacheEntry {
    settings: Settings
    readAt: number
    generation: number
}

export function createSettingsReadCache(options: {
    ttlMs: number
    now: () => number
    read: (settingsFile: string) => Promise<Settings | null>
}): SettingsReadCache {
    const entries = new Map<string, SettingsCacheEntry>()
    const generations = new Map<string, number>()
    const inFlight = new Map<string, Promise<Settings | null>>()

    function startRead(settingsFile: string): Promise<Settings | null> {
        const shared = inFlight.get(settingsFile)
        if (shared) return shared
        const generationAtStart = generations.get(settingsFile) ?? 0
        const pending = options.read(settingsFile).then((parsed) => {
            if (parsed === null) {
                // Corrupt file: evict so the next read surfaces the parse
                // error loudly (pre-cache semantics).
                const entry = entries.get(settingsFile)
                if (entry && entry.generation === generationAtStart) {
                    entries.delete(settingsFile)
                }
                return null
            }
            const entry = entries.get(settingsFile)
            if (!entry) {
                if (generationAtStart === (generations.get(settingsFile) ?? 0)) {
                    entries.set(settingsFile, {
                        settings: parsed,
                        readAt: options.now(),
                        generation: generationAtStart
                    })
                }
                return parsed
            }
            if (entry.generation !== generationAtStart) {
                // A write-through refresh landed while this read was in
                // flight; it is newer than this (possibly stale-inode)
                // snapshot.
                return entry.settings
            }
            entry.settings = parsed
            entry.readAt = options.now()
            return parsed
        })
        const tracked = pending.finally(() => {
            if (inFlight.get(settingsFile) === tracked) {
                inFlight.delete(settingsFile)
            }
        })
        inFlight.set(settingsFile, tracked)
        return tracked
    }

    return {
        read(settingsFile) {
            const entry = entries.get(settingsFile)
            if (!entry) {
                return startRead(settingsFile)
            }
            if (options.now() - entry.readAt < options.ttlMs) {
                return Promise.resolve(entry.settings)
            }
            // Stale: answer from memory now, revalidate once in background.
            if (!inFlight.has(settingsFile)) {
                startRead(settingsFile).catch(() => undefined)
            }
            return Promise.resolve(entry.settings)
        },
        refreshAfterWrite(settingsFile, settings) {
            const generation = (generations.get(settingsFile) ?? 0) + 1
            generations.set(settingsFile, generation)
            const entry = entries.get(settingsFile)
            if (entry) {
                entry.settings = settings
                entry.readAt = options.now()
                entry.generation = generation
            } else {
                entries.set(settingsFile, {
                    settings,
                    readAt: options.now(),
                    generation
                })
            }
        },
        clear() {
            entries.clear()
            generations.clear()
            inFlight.clear()
        }
    }
}

export const SETTINGS_READ_CACHE_TTL_MS = 5_000

const defaultSettingsReadCache = createSettingsReadCache({
    ttlMs: SETTINGS_READ_CACHE_TTL_MS,
    now: () => Date.now(),
    read: (settingsFile) => readSettings(settingsFile)
})

/** Hot-path cached read with stale-while-revalidate semantics (see above). */
export function readSettingsCached(settingsFile: string): Promise<Settings | null> {
    return defaultSettingsReadCache.read(settingsFile)
}

/** Throwing variant of {@link readSettingsCached} for flag helpers. */
export async function readSettingsOrThrowCached(settingsFile: string): Promise<Settings> {
    return settingsOrUnreadable(await readSettingsCached(settingsFile), settingsFile)
}

/** @internal isolate the module-level default cache between tests. */
export function __resetSettingsReadCacheForTests(): void {
    defaultSettingsReadCache.clear()
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
    // Write-through: hot readers see this immediately without a disk read.
    defaultSettingsReadCache.refreshAfterWrite(settingsFile, settings)
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

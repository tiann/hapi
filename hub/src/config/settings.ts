import { constants, existsSync, type Stats } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
// Windows does not expose O_NOFOLLOW. The pre-open, handle, and post-open
// identity checks below are the fallback instead of silently trusting open().
const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const NONBLOCK_FLAG = process.platform === 'win32' ? 0 : constants.O_NONBLOCK

function unsafePrivateFile(path: string, reason: string): Error {
    return new Error(`Unsafe private file '${path}': ${reason}`)
}

function assertPrivateRegularFile(path: string, fileStat: Stats): void {
    if (fileStat.isSymbolicLink()) {
        throw unsafePrivateFile(path, 'symbolic links are not allowed')
    }
    if (!fileStat.isFile() || fileStat.nlink !== 1) {
        throw unsafePrivateFile(path, 'expected one regular file link')
    }
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

async function inspectPrivateFilePath(path: string): Promise<Stats | null> {
    try {
        const pathStat = await lstat(path)
        assertPrivateRegularFile(path, pathStat)
        return pathStat
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

async function openPrivateRegularFile(path: string): Promise<FileHandle | null> {
    const beforeOpen = await inspectPrivateFilePath(path)
    if (!beforeOpen) return null

    let handle: FileHandle
    try {
        handle = await open(path, constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG)
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'ENOENT') return null
        if (nodeError.code === 'ELOOP') throw unsafePrivateFile(path, 'symbolic links are not allowed')
        throw error
    }

    try {
        const openedFile = await handle.stat()
        assertPrivateRegularFile(path, openedFile)
        const afterOpen = await inspectPrivateFilePath(path)
        if (!afterOpen
            || !isSameFileIdentity(beforeOpen, openedFile)
            || !isSameFileIdentity(openedFile, afterOpen)) {
            throw unsafePrivateFile(path, 'path identity changed while opening')
        }
        await handle.chmod(PRIVATE_FILE_MODE)
        return handle
    } catch (error) {
        await handle.close().catch(() => {})
        throw error
    }
}

async function secureExistingFile(path: string): Promise<void> {
    const handle = await openPrivateRegularFile(path)
    if (handle) {
        await handle.close()
    }
}

async function writePrivateFileAtomically(path: string, contents: string): Promise<void> {
    await secureExistingFile(`${path}.tmp`)
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    let handle: FileHandle | null = null
    let renamed = false
    try {
        handle = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
            PRIVATE_FILE_MODE,
        )
        await handle.chmod(PRIVATE_FILE_MODE)
        await handle.writeFile(contents, { encoding: 'utf8' })
        await handle.sync()
        await handle.close()
        handle = null
        await rename(temporary, path)
        renamed = true
    } finally {
        await handle?.close().catch(() => {})
        if (!renamed) await unlink(temporary).catch(() => {})
    }
}

export interface Settings {
    machineId?: string
    machineIdConfirmedByServer?: boolean
    runnerAutoStartWhenRunningHappy?: boolean
    cliApiToken?: string
    namespaceTokens?: Record<string, string>
    vapidKeys?: {
        publicKey: string
        privateKey: string
    }
    // Server configuration (persisted from environment variables)
    telegramBotToken?: string
    telegramNotification?: boolean
    listenHost?: string
    listenPort?: number
    publicUrl?: string
    corsOrigins?: string[]
    // Legacy field names (for migration, read-only)
    webappHost?: string
    webappPort?: number
    webappUrl?: string
}

export function getSettingsFile(dataDir: string): string {
    return join(dataDir, 'settings.json')
}

/**
 * Read settings from file, preserving all existing fields.
 * Returns null if file exists but cannot be parsed (to avoid data loss).
 */
export async function readSettings(settingsFile: string): Promise<Settings | null> {
    await secureExistingFile(`${settingsFile}.tmp`)
    const handle = await openPrivateRegularFile(settingsFile)
    if (!handle) {
        return {}
    }
    try {
        const content = await handle.readFile({ encoding: 'utf8' })
        return JSON.parse(content)
    } catch (error) {
        // Return null to signal parse error - caller should not overwrite
        console.error(`[WARN] Failed to parse ${settingsFile}: ${error}`)
        return null
    } finally {
        await handle.close()
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

/**
 * Write settings to file atomically (temp file + rename)
 */
export async function writeSettings(settingsFile: string, settings: Settings): Promise<void> {
    const dir = dirname(settingsFile)
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    }

    await secureExistingFile(settingsFile)
    await writePrivateFileAtomically(settingsFile, JSON.stringify(settings, null, 2))
}

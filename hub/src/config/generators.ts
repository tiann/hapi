import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { type FileHandle, chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readSettingsOrThrow, writeSettings, type Settings } from './settings'

const NOFOLLOW_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const NONBLOCK_FLAG = process.platform === 'win32' ? 0 : constants.O_NONBLOCK
const LINK_SETTLE_ATTEMPTS = 25
const LINK_SETTLE_DELAY_MS = 2

function unsafePrivateFile(path: string, reason: string): Error {
    return new Error("Unsafe private file '" + path + "': " + reason)
}

function unsafePrivateDirectory(path: string, reason: string): Error {
    return new Error("Unsafe private directory '" + path + "': " + reason)
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

function assertCurrentUserOwns(path: string, node: Stats, kind: 'file' | 'directory'): void {
    if (typeof process.getuid === 'function' && node.uid !== process.getuid()) {
        const error = kind === 'file' ? unsafePrivateFile : unsafePrivateDirectory
        throw error(path, 'must be owned by the current user')
    }
}

function assertOwnedRegularFile(path: string, node: Stats): void {
    if (node.isSymbolicLink()) {
        throw unsafePrivateFile(path, 'symbolic links are not allowed')
    }
    if (!node.isFile()) {
        throw unsafePrivateFile(path, 'expected a regular file')
    }
    assertCurrentUserOwns(path, node, 'file')
}

function assertPrivateRegularFile(path: string, node: Stats): void {
    assertOwnedRegularFile(path, node)
    if (node.nlink !== 1) {
        throw unsafePrivateFile(path, 'expected one regular file link')
    }
}

function assertPrivateMode(
    path: string,
    node: Stats,
    mode: number,
    kind: 'file' | 'directory',
): void {
    if (process.platform === 'win32' || (node.mode & 0o777) === mode) return
    const error = kind === 'file' ? unsafePrivateFile : unsafePrivateDirectory
    throw error(path, `expected mode ${mode.toString(8)}`)
}

function assertPrivateDirectory(path: string, node: Stats): void {
    if (node.isSymbolicLink()) {
        throw unsafePrivateDirectory(path, 'symbolic links are not allowed')
    }
    if (!node.isDirectory()) {
        throw unsafePrivateDirectory(path, 'expected a directory')
    }
    assertCurrentUserOwns(path, node, 'directory')
}

async function inspectOwnedRegularFilePath(path: string): Promise<Stats | null> {
    try {
        const pathStat = await lstat(path)
        assertOwnedRegularFile(path, pathStat)
        return pathStat
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    }
}

async function inspectPrivateFilePath(
    path: string,
    options: { settlePublicationLink?: boolean } = {},
): Promise<Stats | null> {
    for (let attempt = 0; ; attempt += 1) {
        const pathStat = await inspectOwnedRegularFilePath(path)
        if (!pathStat) return null
        if (pathStat.nlink === 1) return pathStat
        if (!options.settlePublicationLink
            || pathStat.nlink < 2
            || attempt >= LINK_SETTLE_ATTEMPTS - 1) {
            throw unsafePrivateFile(path, 'expected one regular file link')
        }
        await new Promise((resolve) => setTimeout(resolve, LINK_SETTLE_DELAY_MS))
    }
}

async function ensurePrivateDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode })
    const beforeChmod = await lstat(path)
    assertPrivateDirectory(path, beforeChmod)
    await chmod(path, mode)
    const afterChmod = await lstat(path)
    assertPrivateDirectory(path, afterChmod)
    assertPrivateMode(path, afterChmod, mode, 'directory')
    if (!isSameFileIdentity(beforeChmod, afterChmod)) {
        throw unsafePrivateDirectory(path, 'path identity changed while securing it')
    }
}

async function openPrivateRegularFile(path: string, mode: number): Promise<FileHandle | null> {
    const beforeOpen = await inspectPrivateFilePath(path, { settlePublicationLink: true })
    if (!beforeOpen) return null

    let handle: FileHandle
    try {
        handle = await open(path, constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG)
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'ENOENT') return null
        if (nodeError.code === 'ELOOP') {
            throw unsafePrivateFile(path, 'symbolic links are not allowed')
        }
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
        await handle.chmod(mode)
        const securedFile = await handle.stat()
        assertPrivateRegularFile(path, securedFile)
        assertPrivateMode(path, securedFile, mode, 'file')
        if (!isSameFileIdentity(openedFile, securedFile)) {
            throw unsafePrivateFile(path, 'descriptor identity changed while securing it')
        }
        return handle
    } catch (error) {
        await handle.close().catch(() => {})
        throw error
    }
}

async function createPrivateFileExclusively(
    path: string,
    contents: string,
    mode: number,
): Promise<boolean> {
    // Prepare and sync a private inode before publishing its final name. A hard
    // link is the no-overwrite commit point; readers may briefly see two links
    // while the private temporary name is removed, never partial data.
    const tempPath = join(
        dirname(path),
        `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let handle: FileHandle | null = null
    let openedFile: Stats | null = null
    try {
        handle = await open(
            tempPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW_FLAG,
            mode,
        )
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'ELOOP') {
            throw unsafePrivateFile(tempPath, 'symbolic links are not allowed')
        }
        throw error
    }

    try {
        openedFile = await handle.stat()
        assertPrivateRegularFile(tempPath, openedFile)
        await handle.chmod(mode)
        const securedFile = await handle.stat()
        assertPrivateRegularFile(tempPath, securedFile)
        assertPrivateMode(tempPath, securedFile, mode, 'file')
        if (!isSameFileIdentity(openedFile, securedFile)) {
            throw unsafePrivateFile(tempPath, 'descriptor identity changed while securing it')
        }
        await handle.writeFile(contents, { encoding: 'utf8' })
        await handle.sync()
        const afterWrite = await inspectPrivateFilePath(tempPath)
        if (!afterWrite || !isSameFileIdentity(openedFile, afterWrite)) {
            throw unsafePrivateFile(tempPath, 'path identity changed while preparing it')
        }

        try {
            await link(tempPath, path)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
            throw error
        }

        const published = await inspectOwnedRegularFilePath(path)
        if (!published
            || published.nlink !== 2
            || !isSameFileIdentity(openedFile, published)) {
            throw unsafePrivateFile(path, 'published path does not match the prepared file')
        }

        await unlink(tempPath)
        const committed = await inspectPrivateFilePath(path)
        if (!committed || !isSameFileIdentity(openedFile, committed)) {
            throw unsafePrivateFile(path, 'path identity changed while committing it')
        }
        return true
    } finally {
        if (openedFile) {
            const remainingTemp = await inspectOwnedRegularFilePath(tempPath)
            if (remainingTemp) {
                if (!isSameFileIdentity(openedFile, remainingTemp)) {
                    throw unsafePrivateFile(tempPath, 'path identity changed before cleanup')
                }
                await unlink(tempPath)
            }
        }
        await handle.close()
    }
}

export type GetOrCreateResult<T> = {
    value: T
    created: boolean
}

export type SettingsValueReadResult<T> = {
    value: T
    writeBack?: boolean
}

export async function getOrCreateSettingsValue<T>(options: {
    settingsFile: string
    readValue: (settings: Settings) => SettingsValueReadResult<T> | null
    writeValue: (settings: Settings, value: T) => void
    generate: () => T
}): Promise<GetOrCreateResult<T>> {
    const settings = await readSettingsOrThrow(options.settingsFile)
    const existing = options.readValue(settings)
    if (existing) {
        if (existing.writeBack) {
            await writeSettings(options.settingsFile, settings)
        }
        return { value: existing.value, created: false }
    }

    const generated = options.generate()
    options.writeValue(settings, generated)
    await writeSettings(options.settingsFile, settings)
    return { value: generated, created: true }
}

export async function getOrCreateJsonFile<T>(options: {
    filePath: string
    readValue: (raw: string) => T
    writeValue: (value: T) => string
    generate: () => T
    fileMode?: number
    dirMode?: number
}): Promise<GetOrCreateResult<T>> {
    const fileMode = options.fileMode ?? 0o600
    const dirMode = options.dirMode ?? 0o700
    const dir = dirname(options.filePath)

    await ensurePrivateDirectory(dir, dirMode)
    const existing = await openPrivateRegularFile(options.filePath, fileMode)
    if (existing) {
        try {
            const raw = await existing.readFile({ encoding: 'utf8' })
            return { value: options.readValue(raw), created: false }
        } finally {
            await existing.close()
        }
    }

    const generated = options.generate()
    const created = await createPrivateFileExclusively(
        options.filePath,
        options.writeValue(generated),
        fileMode,
    )
    if (created) {
        return { value: generated, created: true }
    }

    // Another process won the exclusive creation race. Accept only the exact
    // private regular file it created; never overwrite or follow the raced node.
    const raced = await openPrivateRegularFile(options.filePath, fileMode)
    if (!raced) {
        throw unsafePrivateFile(options.filePath, 'disappeared after an exclusive creation race')
    }
    try {
        const raw = await raced.readFile({ encoding: 'utf8' })
        return { value: options.readValue(raw), created: false }
    } finally {
        await raced.close()
    }
}

import { constants, type Stats } from 'node:fs'
import { lstat, open, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// Recycle-bin mutations must keep using the directory object selected during
// authorization. Node's path-based fs/promises mutations cannot express this;
// the CLI is shipped as Bun, so use Bun FFI only at the native mutation edge.

export type FileIdentity = {
    dev: string
    ino: string
}

export type SecureRenameOptions = {
    sourceDirectoryIdentity: string
    targetDirectoryIdentity: string
    sourceFileIdentity?: FileIdentity
}

export type SecureWritableFile = {
    stat(): Promise<Stats>
    write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>
    chmod(mode: number): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
}

export type SecureQuarantine = {
    path: string
    directoryIdentity: string
    parentDirectoryIdentity: string
}

export type SecureUnlinkOptions = {
    /** Private same-filesystem destination to journal before detaching the file. */
    quarantinePath?: string
    /** Persist the quarantine destination before the source name is detached. */
    onQuarantinePrepared?: (quarantine: SecureQuarantine) => Promise<void>
}

const IS_WINDOWS = process.platform === 'win32'
const POSIX_AT_REMOVEDIR = process.platform === 'darwin' ? 0x80 : 0x200
const POSIX_AT_SYMLINK_NOFOLLOW = process.platform === 'darwin' ? 0x20 : 0x100
const POSIX_S_IFMT = 0o170000
const POSIX_S_IFREG = 0o100000
const POSIX_S_IFDIR = 0o040000
const POSIX_QUARANTINE_DIRECTORY_PATTERN = /^\.hapi-recycle-quarantine-[0-9a-f-]{36}$/i
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY
    | (constants.O_DIRECTORY ?? 0)
    | (constants.O_NOFOLLOW ?? 0)

export type FileIdentityStats = {
    dev: number | bigint
    ino: number | bigint
}

function identityFromStats(stats: FileIdentityStats): FileIdentity {
    return { dev: String(stats.dev), ino: String(stats.ino) }
}

function identityKey(identity: FileIdentity): string {
    return `${identity.dev}:${identity.ino}`
}

function windowsIdentityFromFileIdentity(identity: FileIdentity): string {
    const ino = BigInt(identity.ino)
    return `${identity.dev}:${ino >> 32n}:${ino & 0xffffffffn}`
}

function isSameFileIdentity(left: Stats, right: Stats): boolean {
    return left.isFile()
        && right.isFile()
        && left.dev === right.dev
        && left.ino === right.ino
}

function isSimpleName(name: string): boolean {
    return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

function assertSiblingPaths(sourcePath: string, targetPath: string): { sourceDirectory: string; targetDirectory: string; sourceName: string; targetName: string } {
    const sourceDirectory = dirname(sourcePath)
    const targetDirectory = dirname(targetPath)
    const sourceName = basename(sourcePath)
    const targetName = basename(targetPath)
    if (!isSimpleName(sourceName) || !isSimpleName(targetName)) {
        throw new Error('Secure file operations require simple file names')
    }
    return { sourceDirectory, targetDirectory, sourceName, targetName }
}

function assertDirectoryIdentity(actual: string, expected: string): void {
    if (actual !== expected) throw new Error('Secure file operation parent changed during the operation')
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function assertFileIdentity(path: string, expected: FileIdentity | undefined): Promise<void> {
    if (!expected) return
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink() || identityKey(identityFromStats(stats)) !== identityKey(expected)) {
        throw new Error('Secure file operation source changed during the operation')
    }
}

type PosixDirectory = {
    kind: 'posix'
    handle: FileHandle
    identity: string
}

type WindowsNativeSymbols = {
    CreateFileW: (path: number, desiredAccess: number, shareMode: number, securityAttributes: number, creationDisposition: number, flagsAndAttributes: number, templateFile: number) => number
    CloseHandle: (handle: number) => number
    GetLastError: () => number
    GetFileInformationByHandle: (handle: number, information: number) => number
    NtSetInformationFile: (handle: number, ioStatusBlock: number, information: number, size: number, informationClass: number) => number
    NtCreateFile: (fileHandle: number, desiredAccess: number, objectAttributes: number, ioStatusBlock: number, allocationSize: number, fileAttributes: number, shareAccess: number, createDisposition: number, createOptions: number, eaBuffer: number, eaLength: number) => number
    WriteFile: (handle: number, buffer: number, bytesToWrite: number, bytesWritten: number, overlapped: number) => number
    FlushFileBuffers: (handle: number) => number
}

type BunFfi = {
    dlopen: (path: string, symbols: Record<string, unknown>) => { symbols: Record<string, (...args: (number | string)[]) => number> }
    ptr: (value: ArrayBufferView) => number
}

type WindowsDirectory = {
    kind: 'windows'
    handle: number
    identity: string
    symbols: WindowsNativeSymbols
}

type SecureDirectory = PosixDirectory | WindowsDirectory

let ffiModule: Promise<BunFfi> | null = null
let windowsSymbols: Promise<WindowsNativeSymbols> | null = null

async function loadFfi(): Promise<BunFfi> {
    if (!process.versions.bun) {
        throw new Error('Secure directory operations require the Bun runtime')
    }
    if (!ffiModule) ffiModule = import('bun:ffi') as unknown as Promise<BunFfi>
    return await ffiModule
}

async function getWindowsSymbols(): Promise<WindowsNativeSymbols> {
    if (!windowsSymbols) {
        windowsSymbols = (async () => {
            const { dlopen } = await loadFfi()
            const { symbols } = dlopen('kernel32.dll', {
                CreateFileW: {
                    args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'],
                    returns: 'ptr',
                },
                CloseHandle: { args: ['ptr'], returns: 'u32' },
                GetLastError: { args: [], returns: 'u32' },
                GetFileInformationByHandle: { args: ['ptr', 'ptr'], returns: 'u32' },
                WriteFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'u32' },
                FlushFileBuffers: { args: ['ptr'], returns: 'u32' },
            })
            const { symbols: nativeSymbols } = dlopen('ntdll.dll', {
                NtSetInformationFile: { args: ['ptr', 'ptr', 'ptr', 'u32', 'u32'], returns: 'i32' },
                NtCreateFile: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'], returns: 'i32' },
            })
            return { ...symbols, ...nativeSymbols } as unknown as WindowsNativeSymbols
        })()
    }
    return await windowsSymbols
}

async function utf16Pointer(value: string): Promise<{ buffer: Buffer; pointer: number }> {
    const buffer = Buffer.from(`${value}\0`, 'utf16le')
    const { ptr } = await loadFfi()
    return { buffer, pointer: ptr(buffer) }
}

function isInvalidWindowsHandle(handle: number): boolean {
    return handle === 0 || handle === -1
}

function windowsError(symbols: WindowsNativeSymbols, operation: string): Error {
    const code = symbols.GetLastError()
    return new Error(`${operation} failed with Windows error ${code}`)
}

function readWindowsFileIdentity(symbols: WindowsNativeSymbols, handle: number, pointer: (value: ArrayBufferView) => number): { identity: string; attributes: number } {
    const information = Buffer.alloc(52)
    if (!symbols.GetFileInformationByHandle(handle, pointer(information))) {
        throw windowsError(symbols, 'GetFileInformationByHandle')
    }
    const attributes = information.readUInt32LE(0)
    const volumeSerial = information.readUInt32LE(28)
    const fileIndexHigh = information.readUInt32LE(44)
    const fileIndexLow = information.readUInt32LE(48)
    return {
        attributes,
        identity: `${volumeSerial}:${fileIndexHigh}:${fileIndexLow}`,
    }
}

async function openSecureDirectory(path: string, expectedIdentity?: string): Promise<SecureDirectory> {
    if (!IS_WINDOWS) {
        const handle = await open(path, DIRECTORY_OPEN_FLAGS)
        try {
            const stats = await handle.stat()
            if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Secure file operation parent is not a real directory')
            const identity = identityKey(identityFromStats(stats))
            assertDirectoryIdentity(identity, expectedIdentity ?? identity)
            return { kind: 'posix', handle, identity }
        } catch (error) {
            await handle.close()
            throw error
        }
    }

    const symbols = await getWindowsSymbols()
    const { ptr: pointer } = await loadFfi()
    const { buffer, pointer: pathPointer } = await utf16Pointer(path)
    void buffer
    const handle = symbols.CreateFileW(
        pathPointer,
        0x0001 | 0x0080,
        0x00000007,
        0,
        3,
        0x02000000 | 0x00200000,
        0,
    )
    if (isInvalidWindowsHandle(handle)) throw windowsError(symbols, 'CreateFileW directory')
    try {
        const information = readWindowsFileIdentity(symbols, handle, pointer)
        if ((information.attributes & 0x00000010) === 0 || (information.attributes & 0x00000400) !== 0) {
            throw new Error('Secure file operation parent is not a real directory')
        }
        assertDirectoryIdentity(information.identity, expectedIdentity ?? information.identity)
        return { kind: 'windows', handle, identity: information.identity, symbols }
    } catch (error) {
        symbols.CloseHandle(handle)
        throw error
    }
}

async function closeSecureDirectory(directory: SecureDirectory): Promise<void> {
    if (directory.kind === 'posix') {
        await directory.handle.close()
        return
    }
    if (!directory.symbols.CloseHandle(directory.handle)) throw windowsError(directory.symbols, 'CloseHandle')
}

async function openWindowsFile(path: string, expectedIdentity?: FileIdentity): Promise<{ handle: number; symbols: WindowsNativeSymbols; identity: string }> {
    const symbols = await getWindowsSymbols()
    const { ptr: pointer } = await loadFfi()
    const { buffer, pointer: pathPointer } = await utf16Pointer(path)
    void buffer
    const handle = symbols.CreateFileW(
        pathPointer,
        0x00010000 | 0x00000080,
        0x00000007,
        0,
        3,
        0x00200000,
        0,
    )
    if (isInvalidWindowsHandle(handle)) throw windowsError(symbols, 'CreateFileW file')
    try {
        const information = readWindowsFileIdentity(symbols, handle, pointer)
        if ((information.attributes & 0x00000010) !== 0 || (information.attributes & 0x00000400) !== 0) {
            throw new Error('Secure file operation source is not a regular file')
        }
        if (expectedIdentity && information.identity !== windowsIdentityFromFileIdentity(expectedIdentity)) {
            throw new Error('Secure file operation source changed during the operation')
        }
        await assertFileIdentity(path, expectedIdentity)
        return { handle, symbols, identity: information.identity }
    } catch (error) {
        symbols.CloseHandle(handle)
        throw error
    }
}

async function createWindowsRenameInformation(targetName: string, targetDirectoryHandle: number): Promise<{ buffer: Buffer; pointer: number }> {
    const fileName = Buffer.from(targetName, 'utf16le')
    const pointerSize = process.arch === 'ia32' ? 4 : 8
    const fileNameOffset = pointerSize === 4 ? 12 : 20
    const buffer = Buffer.alloc(fileNameOffset + fileName.length)
    buffer.writeUInt8(0, 0)
    if (pointerSize === 4) buffer.writeUInt32LE(targetDirectoryHandle, 4)
    else buffer.writeBigUInt64LE(BigInt(targetDirectoryHandle), 8)
    buffer.writeUInt32LE(fileName.length, pointerSize === 4 ? 8 : 16)
    fileName.copy(buffer, fileNameOffset)
    const { ptr } = await loadFfi()
    return { buffer, pointer: ptr(buffer) }
}

async function secureRenameWindows(
    sourcePath: string,
    targetName: string,
    targetDirectory: WindowsDirectory,
    sourceIdentity: FileIdentity | undefined,
): Promise<void> {
    // SetFileInformationByHandle does not reliably honor RootDirectory for a
    // relative rename on supported Windows filesystems. NtSetInformationFile
    // consumes the same FILE_RENAME_INFORMATION layout and preserves the
    // directory-handle-relative operation.
    const source = await openWindowsFile(sourcePath, sourceIdentity)
    try {
        const { buffer, pointer } = await createWindowsRenameInformation(targetName, targetDirectory.handle)
        void buffer
        const ioStatusBlock = Buffer.alloc(process.arch === 'ia32' ? 8 : 16)
        const status = source.symbols.NtSetInformationFile(source.handle, await bufferPointer(ioStatusBlock), pointer, buffer.length, 10)
        if (status < 0) {
            throw new Error(`NtSetInformationFile rename failed with status 0x${(status >>> 0).toString(16)}`)
        }
    } finally {
        if (!source.symbols.CloseHandle(source.handle)) throw windowsError(source.symbols, 'CloseHandle source')
    }
}

async function secureUnlinkWindows(path: string, expectedIdentity?: FileIdentity): Promise<void> {
    const file = await openWindowsFile(path, expectedIdentity)
    try {
        const information = Buffer.alloc(4)
        information.writeUInt32LE(0x00000001 | 0x00000002 | 0x00000010, 0)
        const ioStatusBlock = Buffer.alloc(process.arch === 'ia32' ? 8 : 16)
        const status = file.symbols.NtSetInformationFile(
            file.handle,
            await bufferPointer(ioStatusBlock),
            await bufferPointer(information),
            information.length,
            64,
        )
        if (status < 0) {
            throw new Error(`NtSetInformationFile delete failed with status 0x${(status >>> 0).toString(16)}`)
        }
    } finally {
        if (!file.symbols.CloseHandle(file.handle)) throw windowsError(file.symbols, 'CloseHandle delete')
    }
}

async function markWindowsHandleForDeletion(symbols: WindowsNativeSymbols, handle: number): Promise<void> {
    const information = Buffer.alloc(4)
    information.writeUInt32LE(0x00000001 | 0x00000002 | 0x00000010, 0)
    const ioStatusBlock = Buffer.alloc(process.arch === 'ia32' ? 8 : 16)
    const status = symbols.NtSetInformationFile(
        handle,
        await bufferPointer(ioStatusBlock),
        await bufferPointer(information),
        information.length,
        64,
    )
    if (status < 0) throw new Error(`NtSetInformationFile delete failed with status 0x${(status >>> 0).toString(16)}`)
}

async function bufferPointer(buffer: ArrayBufferView): Promise<number> {
    const { ptr } = await loadFfi()
    return ptr(buffer)
}

async function getPosixSymbols() {
    const isDarwin = process.platform === 'darwin'
    const library = isDarwin ? 'libSystem.B.dylib' : 'libc.so.6'
    const { dlopen } = await loadFfi()
    if (isDarwin) {
        const statSymbol = process.arch === 'x64' ? 'fstatat64' : 'fstatat'
        const { symbols } = dlopen(library, {
            renameatx_np: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
            unlinkat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' },
            mkdirat: { args: ['i32', 'cstring', 'u32'], returns: 'i32' },
            [statSymbol]: { args: ['i32', 'cstring', 'ptr', 'i32'], returns: 'i32' },
            openat: { args: ['i32', 'cstring', 'i32', 'u32'], returns: 'i32' },
            close: { args: ['i32'], returns: 'i32' },
        })
        return {
            renameNoReplace: symbols.renameatx_np,
            unlinkat: symbols.unlinkat,
            mkdirat: symbols.mkdirat,
            fstatat: symbols[statSymbol],
            openat: symbols.openat,
            close: symbols.close,
            noReplaceFlag: 0x00000004,
        }
    }
    const { symbols } = dlopen(library, {
        renameat2: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
        unlinkat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' },
        mkdirat: { args: ['i32', 'cstring', 'u32'], returns: 'i32' },
        fstatat: { args: ['i32', 'cstring', 'ptr', 'i32'], returns: 'i32' },
        openat: { args: ['i32', 'cstring', 'i32', 'u32'], returns: 'i32' },
        close: { args: ['i32'], returns: 'i32' },
    })
    return {
        renameNoReplace: symbols.renameat2,
        unlinkat: symbols.unlinkat,
        mkdirat: symbols.mkdirat,
        fstatat: symbols.fstatat,
        openat: symbols.openat,
        close: symbols.close,
        noReplaceFlag: 0x00000001,
    }
}

let posixSymbols: Promise<Awaited<ReturnType<typeof getPosixSymbols>>> | null = null

async function getCachedPosixSymbols() {
    if (!posixSymbols) posixSymbols = getPosixSymbols()
    return await posixSymbols
}

function posixDescriptorPath(fd: number): string {
    const prefix = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
    return `${prefix}/${fd}`
}

type PosixChildStat = {
    dev: string
    ino: string
    mode: number
}

function decodePosixChildStat(buffer: Buffer): PosixChildStat {
    if (process.platform === 'darwin') {
        return {
            dev: String(buffer.readUInt32LE(0)),
            ino: buffer.readBigUInt64LE(8).toString(),
            mode: buffer.readUInt16LE(4),
        }
    }
    const modeOffset = process.arch === 'arm64' ? 16 : 24
    return {
        dev: buffer.readBigUInt64LE(0).toString(),
        ino: buffer.readBigUInt64LE(8).toString(),
        mode: buffer.readUInt32LE(modeOffset),
    }
}

async function statPosixChild(
    directory: PosixDirectory,
    name: string,
    fallbackPath?: string,
): Promise<PosixChildStat> {
    if (!isSimpleName(name)) throw new Error('Secure directory-relative stat name is invalid')
    const symbols = await getCachedPosixSymbols()
    const buffer = Buffer.alloc(process.platform === 'darwin' ? 256 : 512)
    const { ptr } = await loadFfi()
    const result = symbols.fstatat(
        directory.handle.fd,
        name,
        ptr(buffer),
        POSIX_AT_SYMLINK_NOFOLLOW,
    )
    if (result !== 0) {
        if (fallbackPath) {
            try {
                await lstat(fallbackPath)
            } catch (error) {
                if (isNotFound(error)) throw error
            }
        }
        throw new Error('Directory-relative stat failed')
    }
    return decodePosixChildStat(buffer)
}

async function openPosixDirectoryAt(parent: PosixDirectory, name: string): Promise<PosixDirectory> {
    if (!isSimpleName(name)) throw new Error('Secure quarantine directory name is invalid')
    const symbols = await getCachedPosixSymbols()
    const rawFd = symbols.openat(parent.handle.fd, name, DIRECTORY_OPEN_FLAGS, 0)
    if (rawFd < 0) throw new Error('Secure quarantine directory open failed')
    let handle: FileHandle | null = null
    try {
        // The descriptor path is backed by the already pinned raw fd, so this
        // duplication does not re-resolve the writable parent pathname.
        handle = await open(posixDescriptorPath(rawFd), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
        const stats = await handle.stat()
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('Secure quarantine directory is not a real directory')
        }
        return { kind: 'posix', handle, identity: identityKey(identityFromStats(stats)) }
    } catch (error) {
        if (handle) await handle.close().catch(() => {})
        throw error
    } finally {
        symbols.close(rawFd)
    }
}

function quarantineParts(sourcePath: string, quarantinePath: string): { directoryName: string; fileName: string } {
    const sourceDirectory = resolve(dirname(sourcePath))
    const quarantineDirectory = resolve(dirname(quarantinePath))
    const directoryName = basename(quarantineDirectory)
    const fileName = basename(quarantinePath)
    if (
        resolve(dirname(quarantineDirectory)) !== sourceDirectory
        || !POSIX_QUARANTINE_DIRECTORY_PATTERN.test(directoryName)
        || !isSimpleName(fileName)
        || fileName !== basename(sourcePath)
    ) {
        throw new Error('Secure quarantine path must be a private sibling directory')
    }
    return { directoryName, fileName }
}

function quarantineCleanupName(fileName: string): string {
    return fileName === '.hapi-recycle-cleanup'
        ? '.hapi-recycle-cleanup-2'
        : '.hapi-recycle-cleanup'
}

async function removeFileFromPosixDirectory(
    directory: PosixDirectory,
    sourceName: string,
    expectedIdentity: FileIdentity,
): Promise<void> {
    const symbols = await getCachedPosixSymbols()
    const cleanupName = quarantineCleanupName(sourceName)
    const moved = symbols.renameNoReplace(
        directory.handle.fd,
        sourceName,
        directory.handle.fd,
        cleanupName,
        symbols.noReplaceFlag,
    )
    if (moved !== 0) throw new Error('Identity-bound POSIX cleanup could not isolate the file')
    let cleanupContainsFile = true
    try {
        const stats = await statPosixChild(directory, cleanupName)
        if (
            (stats.mode & POSIX_S_IFMT) !== POSIX_S_IFREG
            || stats.dev !== expectedIdentity.dev
            || stats.ino !== expectedIdentity.ino
        ) {
            throw new Error('POSIX cleanup identity changed during the operation')
        }
        const removed = symbols.unlinkat(directory.handle.fd, cleanupName, 0)
        if (removed !== 0) throw new Error('Secure quarantine file cleanup failed')
        cleanupContainsFile = false
    } finally {
        if (cleanupContainsFile) {
            const restored = symbols.renameNoReplace(
                directory.handle.fd,
                cleanupName,
                directory.handle.fd,
                sourceName,
                symbols.noReplaceFlag,
            )
            if (restored === 0) {
                cleanupContainsFile = false
            } else {
                // Keep the deterministic cleanup name in the private
                // quarantine directory when a replacement occupies sourceName.
                // The journaled cleanup path can find it on the next pass.
            }
        }
    }
}

async function removeEmptyPosixQuarantineDirectory(parent: PosixDirectory, directoryName: string): Promise<void> {
    const symbols = await getCachedPosixSymbols()
    const result = symbols.unlinkat(parent.handle.fd, directoryName, POSIX_AT_REMOVEDIR)
    if (result !== 0) throw new Error('Secure quarantine directory cleanup failed')
    await parent.handle.sync()
}

async function preparePosixQuarantine(
    parent: PosixDirectory,
    sourcePath: string,
    quarantinePath: string | undefined,
): Promise<{ info: SecureQuarantine; directoryName: string; directory: PosixDirectory }> {
    const resolvedQuarantinePath = resolve(quarantinePath
        ?? join(dirname(sourcePath), `.hapi-recycle-quarantine-${randomUUID()}`, basename(sourcePath)))
    const { directoryName } = quarantineParts(sourcePath, resolvedQuarantinePath)
    const symbols = await getCachedPosixSymbols()
    if (symbols.mkdirat(parent.handle.fd, directoryName, 0o700) !== 0) {
        throw new Error('Secure quarantine directory creation failed')
    }
    let directory: PosixDirectory | null = null
    try {
        directory = await openPosixDirectoryAt(parent, directoryName)
        // Persist the private directory entry before exposing its path to the
        // manager journal or moving a file into it.
        await parent.handle.sync()
        return {
            info: {
                path: resolvedQuarantinePath,
                directoryIdentity: directory.identity,
                parentDirectoryIdentity: parent.identity,
            },
            directoryName,
            directory,
        }
    } catch (error) {
        if (directory) await closeSecureDirectory(directory).catch(() => {})
        await removeEmptyPosixQuarantineDirectory(parent, directoryName).catch(() => {})
        throw error
    }
}

async function openPosixStagingFile(path: string, directoryIdentity: string, mode: number): Promise<SecureWritableFile> {
    const directory = await openSecureDirectory(dirname(path), directoryIdentity)
    const name = basename(path)
    const symbols = await getCachedPosixSymbols()
    const rawFd = symbols.openat(
        (directory as PosixDirectory).handle.fd,
        name,
        constants.O_WRONLY
            | constants.O_CREAT
            | constants.O_EXCL
            | (constants.O_NOFOLLOW ?? 0),
        0o600,
    )
    if (rawFd < 0) {
        await closeSecureDirectory(directory)
        throw new Error('Secure staging creation failed')
    }
    let handle: FileHandle | null = null
    try {
        const descriptorPath = process.platform === 'linux'
            ? `/proc/self/fd/${rawFd}`
            : `/dev/fd/${rawFd}`
        const rawStats = await stat(descriptorPath)
        handle = await open(path, 'r+')
        const openedStats = await handle.stat()
        if (!isSameFileIdentity(rawStats, openedStats)) {
            throw new Error('Secure staging path changed during creation')
        }
        return handle
    } catch (error) {
        if (handle) await handle.close().catch(() => {})
        throw error
    } finally {
        await symbols.close(rawFd)
        await closeSecureDirectory(directory)
    }
}

async function createWindowsStagingHandle(
    path: string,
    directory: WindowsDirectory,
): Promise<{ handle: number; identity: string }> {
    const symbols = directory.symbols
    const name = basename(path)
    const nameBuffer = Buffer.from(`${name}\0`, 'utf16le')
    const pointerSize = process.arch === 'ia32' ? 4 : 8
    const unicodeBuffer = Buffer.alloc(pointerSize === 4 ? 12 : 16)
    unicodeBuffer.writeUInt16LE(nameBuffer.length - 2, 0)
    unicodeBuffer.writeUInt16LE(nameBuffer.length, 2)
    const { ptr } = await loadFfi()
    const namePointer = ptr(nameBuffer)
    if (pointerSize === 4) unicodeBuffer.writeUInt32LE(namePointer, 4)
    else unicodeBuffer.writeBigUInt64LE(BigInt(namePointer), 8)
    const objectBuffer = Buffer.alloc(pointerSize === 4 ? 24 : 48)
    objectBuffer.writeUInt32LE(pointerSize === 4 ? 24 : 48, 0)
    if (pointerSize === 4) {
        objectBuffer.writeUInt32LE(directory.handle, 4)
        objectBuffer.writeUInt32LE(ptr(unicodeBuffer), 8)
        objectBuffer.writeUInt32LE(0x40, 12)
    } else {
        objectBuffer.writeBigUInt64LE(BigInt(directory.handle), 8)
        objectBuffer.writeBigUInt64LE(BigInt(ptr(unicodeBuffer)), 16)
        objectBuffer.writeUInt32LE(0x40, 24)
    }
    const ioStatusBlock = Buffer.alloc(pointerSize === 4 ? 8 : 16)
    const handleBuffer = Buffer.alloc(pointerSize)
    const status = symbols.NtCreateFile(
        ptr(handleBuffer),
        0xc0110000,
        ptr(objectBuffer),
        ptr(ioStatusBlock),
        0,
        0x00000080,
        0x00000007,
        2,
        0x00204060,
        0,
        0,
    )
    if (status < 0) throw new Error(`NtCreateFile staging failed with status 0x${(status >>> 0).toString(16)}`)
    const handle = pointerSize === 4 ? handleBuffer.readUInt32LE(0) : Number(handleBuffer.readBigUInt64LE(0))
    const information = readWindowsFileIdentity(symbols, handle, ptr)
    return { handle, identity: information.identity }
}

async function openWindowsStagingFile(path: string, directoryIdentity: string, mode: number): Promise<SecureWritableFile> {
    const directory = await openSecureDirectory(dirname(path), directoryIdentity) as WindowsDirectory
    let nativeHandle: number | null = null
    let nodeHandle: FileHandle | null = null
    try {
        const created = await createWindowsStagingHandle(path, directory)
        nativeHandle = created.handle
        nodeHandle = await open(path, 'r+')
        const nodeStats = await nodeHandle.stat({ bigint: true })
        const nodeIdentity = `${nodeStats.dev}:${nodeStats.ino >> 32n}:${nodeStats.ino & 0xffffffffn}`
        if (!nodeStats.isFile() || nodeIdentity !== created.identity) {
            throw new Error('Secure staging path changed during creation')
        }
        const targetHandle = nodeHandle
        nodeHandle = null
        directory.symbols.CloseHandle(nativeHandle)
        nativeHandle = null
        return targetHandle
    } catch (error) {
        if (nodeHandle) await nodeHandle.close().catch(() => {})
        if (nativeHandle !== null) {
            await markWindowsHandleForDeletion(directory.symbols, nativeHandle).catch(() => {})
            directory.symbols.CloseHandle(nativeHandle)
        }
        throw error
    } finally {
        await closeSecureDirectory(directory)
    }
}

export async function openSecureStagingFile(
    path: string,
    directoryIdentity: string,
    mode: number,
): Promise<SecureWritableFile> {
    return IS_WINDOWS
        ? await openWindowsStagingFile(path, directoryIdentity, mode)
        : await openPosixStagingFile(path, directoryIdentity, mode)
}

export async function getSecureDirectoryIdentity(path: string): Promise<string> {
    const directory = await openSecureDirectory(path)
    try {
        return directory.identity
    } finally {
        await closeSecureDirectory(directory)
    }
}

export async function secureRename(
    sourcePath: string,
    targetPath: string,
    options: SecureRenameOptions,
): Promise<void> {
    const { sourceDirectory, targetDirectory, sourceName, targetName } = assertSiblingPaths(sourcePath, targetPath)
    const sourceHandle = await openSecureDirectory(sourceDirectory, options.sourceDirectoryIdentity)
    let targetHandle: SecureDirectory | null = null
    try {
        targetHandle = await openSecureDirectory(targetDirectory, options.targetDirectoryIdentity)
        await assertFileIdentity(sourcePath, options.sourceFileIdentity)
        if (IS_WINDOWS) {
            await secureRenameWindows(sourcePath, targetName, targetHandle as WindowsDirectory, options.sourceFileIdentity)
            return
        }
        const symbols = await getCachedPosixSymbols()
        const sourcePosix = sourceHandle as PosixDirectory
        const targetPosix = targetHandle as PosixDirectory
        const result = symbols.renameNoReplace(
            sourcePosix.handle.fd,
            sourceName,
            targetPosix.handle.fd,
            targetName,
            symbols.noReplaceFlag,
        )
        if (result !== 0) throw new Error('Atomic no-replace rename failed')
    } finally {
        if (targetHandle) await closeSecureDirectory(targetHandle)
        await closeSecureDirectory(sourceHandle)
    }
}

export async function secureUnlink(
    path: string,
    directoryIdentity: string,
    fileIdentity?: FileIdentity,
    options: SecureUnlinkOptions = {},
): Promise<void> {
    const directoryPath = dirname(path)
    const name = basename(path)
    if (!isSimpleName(name)) throw new Error('Secure file operations require a simple file name')
    const directory = await openSecureDirectory(directoryPath, directoryIdentity)
    try {
        await assertFileIdentity(path, fileIdentity)
        if (IS_WINDOWS) {
            await secureUnlinkWindows(path, fileIdentity)
            return
        }
        if (!fileIdentity) throw new Error('Identity-bound POSIX cleanup requires a file identity')
        const posixDirectory = directory as PosixDirectory
        const symbols = await getCachedPosixSymbols()
        const prepared = await preparePosixQuarantine(posixDirectory, path, options.quarantinePath)
        let quarantineContainsFile = false
        try {
            await options.onQuarantinePrepared?.(prepared.info)
            const moved = symbols.renameNoReplace(
                posixDirectory.handle.fd,
                name,
                prepared.directory.handle.fd,
                name,
                symbols.noReplaceFlag,
            )
            if (moved !== 0) throw new Error('Identity-bound POSIX cleanup could not detach the file')
            quarantineContainsFile = true
            await prepared.directory.handle.sync()
            await removeFileFromPosixDirectory(prepared.directory, name, fileIdentity)
            quarantineContainsFile = false
        } finally {
            await closeSecureDirectory(prepared.directory)
            if (!quarantineContainsFile) {
                await removeEmptyPosixQuarantineDirectory(posixDirectory, basename(dirname(prepared.info.path)))
            }
        }
    } finally {
        await closeSecureDirectory(directory)
    }
}

export async function secureRemoveQuarantinedFile(
    quarantine: SecureQuarantine,
    fileIdentity: FileIdentity,
): Promise<void> {
    if (IS_WINDOWS) throw new Error('POSIX quarantine cleanup is unavailable on Windows')
    const quarantineDirectoryPath = dirname(quarantine.path)
    const directoryName = basename(quarantineDirectoryPath)
    const fileName = basename(quarantine.path)
    if (!POSIX_QUARANTINE_DIRECTORY_PATTERN.test(directoryName) || !isSimpleName(fileName)) {
        throw new Error('Secure quarantine path is invalid')
    }
    const parentPath = dirname(dirname(quarantine.path))
    const parent = await openSecureDirectory(parentPath, quarantine.parentDirectoryIdentity) as PosixDirectory
    let quarantineDirectory: PosixDirectory | null = null
    let quarantineDirectoryExists = false
    try {
        try {
            const stats = await statPosixChild(parent, directoryName, quarantineDirectoryPath)
            if ((stats.mode & POSIX_S_IFMT) !== POSIX_S_IFDIR) {
                throw new Error('Secure quarantine path is not a directory')
            }
            quarantineDirectoryExists = true
        } catch (error) {
            if (isNotFound(error)) return
            throw error
        }
        quarantineDirectory = await openPosixDirectoryAt(parent, directoryName)
        assertDirectoryIdentity(quarantineDirectory.identity, quarantine.directoryIdentity)
        let sourceName = fileName
        try {
            const stats = await statPosixChild(quarantineDirectory, sourceName, quarantine.path)
            if ((stats.mode & POSIX_S_IFMT) === POSIX_S_IFDIR) {
                throw new Error('Secure quarantine path is a directory')
            }
        } catch (error) {
            if (!isNotFound(error)) throw error
            sourceName = quarantineCleanupName(fileName)
            try {
                const cleanupPath = join(quarantineDirectoryPath, sourceName)
                const stats = await statPosixChild(quarantineDirectory, sourceName, cleanupPath)
                if ((stats.mode & POSIX_S_IFMT) === POSIX_S_IFDIR) {
                    throw new Error('Secure quarantine cleanup path is a directory')
                }
            } catch (cleanupError) {
                if (isNotFound(cleanupError)) return
                throw cleanupError
            }
        }
        await removeFileFromPosixDirectory(quarantineDirectory, sourceName, fileIdentity)
    } finally {
        if (quarantineDirectory) await closeSecureDirectory(quarantineDirectory)
        if (quarantineDirectoryExists) {
            try {
                await removeEmptyPosixQuarantineDirectory(parent, directoryName)
            } finally {
                await closeSecureDirectory(parent)
            }
        } else {
            await closeSecureDirectory(parent)
        }
    }
}

export function fileIdentityFromStats(stats: FileIdentityStats): FileIdentity {
    return identityFromStats(stats)
}

export async function fileIdentityFromFileHandle(handle: FileHandle): Promise<FileIdentity> {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('Secure file operation source is not a regular file')
    }
    return identityFromStats(stats)
}

export async function fileIdentityFromPath(path: string): Promise<FileIdentity> {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error('Secure file operation source is not a regular file')
    }
    return identityFromStats(stats)
}

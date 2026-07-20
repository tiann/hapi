import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, open, readdir, rm, lstat, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import { finished } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import type { HostDownloadChunkResponse, HostDownloadDescriptor } from '@hapi/protocol'
import { WorkspaceScope } from './workspaceScope'

const CHUNK_BYTES = 256 * 1024
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 20_000
const DOWNLOAD_TTL_MS = 15 * 60 * 1000

type PreparedDownload = HostDownloadDescriptor & {
    path: string
    tempDirectory?: string
    handle?: FileHandle
    timer: ReturnType<typeof setTimeout>
}

function mimeType(path: string): string {
    if (path.endsWith('.zip')) return 'application/zip'
    const extension = extname(path).toLowerCase()
    if (extension === '.json') return 'application/json'
    if (extension === '.md' || extension === '.txt') return 'text/plain'
    if (extension === '.png') return 'image/png'
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
    return 'application/octet-stream'
}

function isSameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
    return left.dev === right.dev && left.ino === right.ino
}

async function writeZipArchive(path: string, archivePath: string, scope: WorkspaceScope, maxEntries: number): Promise<void> {
    let bytes = 0
    let entries = 0
    const rootName = basename(path)
    const zip = new ZipFile()
    const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
    const outputDone = finished(output)
    void outputDone.catch(() => {})
    const archiveError = new Promise<never>((_resolve, reject) => {
        zip.once('error', reject)
    })
    void archiveError.catch(() => {})
    zip.outputStream.pipe(output)

    const countEntry = (): void => {
        entries += 1
        if (entries > maxEntries) throw new Error(`Directory contains more than ${maxEntries} entries`)
    }

    const addFile = async (filePath: string, entryPath: string): Promise<void> => {
        const handle = await open(filePath, 'r')
        try {
            const openedInfo = await handle.stat()
            const currentPath = await scope.resolveReadableNonGitMetadata(filePath)
            const [pathInfo, currentInfo] = await Promise.all([lstat(filePath), stat(currentPath)])
            if (!openedInfo.isFile() || !pathInfo.isFile()
                || !isSameFile(openedInfo, pathInfo) || !isSameFile(openedInfo, currentInfo)) {
                throw new Error('Directory contents changed while being archived')
            }

            countEntry()
            bytes += openedInfo.size
            if (bytes > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB limit`)

            const stream = handle.createReadStream({ autoClose: false })
            zip.addReadStream(stream, entryPath, {
                size: openedInfo.size,
                mtime: openedInfo.mtime,
                mode: openedInfo.mode
            })
            await Promise.race([finished(stream), archiveError])
        } finally {
            await handle.close()
        }
    }

    const visit = async (current: string): Promise<void> => {
        const directory = await scope.resolveReadableNonGitMetadata(current)
        const [pathInfo, directoryInfo] = await Promise.all([lstat(current), stat(directory)])
        if (!pathInfo.isDirectory() || !directoryInfo.isDirectory() || !isSameFile(pathInfo, directoryInfo)) {
            throw new Error('Directory contents changed while being archived')
        }
        const relativePath = relative(path, current).replace(/\\/g, '/')
        countEntry()
        zip.addEmptyDirectory(relativePath ? `${rootName}/${relativePath}` : rootName)
        const directoryEntries = await readdir(directory, { withFileTypes: true })
        const currentDirectory = await scope.resolveReadableNonGitMetadata(current)
        const currentDirectoryInfo = await stat(currentDirectory)
        if (!isSameFile(directoryInfo, currentDirectoryInfo)) {
            throw new Error('Directory contents changed while being archived')
        }
        for (const entry of directoryEntries) {
            if (entry.name.toLowerCase() === '.git') continue
            const child = join(directory, entry.name)
            const info = await lstat(child)
            if (info.isDirectory()) {
                await visit(child)
                continue
            }
            if (!info.isFile()) throw new Error('Directories containing symlinks or special files cannot be downloaded')
            await addFile(child, `${rootName}/${relative(path, child).replace(/\\/g, '/')}`)
        }
    }

    try {
        await visit(path)
        zip.end()
        await Promise.race([outputDone, archiveError])
    } catch (error) {
        zip.outputStream.unpipe(output)
        output.destroy()
        await outputDone.catch(() => {})
        throw error
    }
}

export class DownloadManager {
    private readonly downloads = new Map<string, PreparedDownload>()
    private archiving = false

    constructor(
        private readonly scope: WorkspaceScope,
        private readonly maxArchiveEntries = MAX_ARCHIVE_ENTRIES
    ) {}

    async prepare(rawPath: string): Promise<HostDownloadDescriptor> {
        const path = await this.scope.resolveReadableNonGitMetadata(rawPath)
        const info = await stat(path)
        const id = randomUUID()
        if (info.isFile()) {
            if (info.size > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB limit`)
            const handle = await open(path, 'r')
            try {
                const [openedInfo, currentPath] = await Promise.all([
                    handle.stat(),
                    this.scope.resolveReadableNonGitMetadata(path)
                ])
                const currentInfo = await stat(currentPath)
                if (!openedInfo.isFile() || openedInfo.dev !== currentInfo.dev || openedInfo.ino !== currentInfo.ino) {
                    throw new Error('Download changed while being prepared')
                }
                if (openedInfo.size > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB limit`)
                return this.register({ id, name: basename(path), mimeType: mimeType(path), size: openedInfo.size, archive: false }, path, undefined, handle)
            } catch (error) {
                await handle.close()
                throw error
            }
        }
        if (!info.isDirectory()) throw new Error('Only files and directories can be downloaded')
        if (this.archiving) throw new Error('Another directory archive is already being prepared')
        this.archiving = true
        let tempDirectory: string | undefined
        try {
            tempDirectory = await mkdtemp(join(tmpdir(), 'hapi-download-'))
            const archivePath = join(tempDirectory, `${basename(path)}.zip`)
            await writeZipArchive(path, archivePath, this.scope, this.maxArchiveEntries)
            const archiveInfo = await stat(archivePath)
            if (archiveInfo.size > MAX_DOWNLOAD_BYTES) {
                throw new Error(`Archive exceeds the ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB limit`)
            }
            return this.register({
                id,
                name: `${basename(path)}.zip`,
                mimeType: 'application/zip',
                size: archiveInfo.size,
                archive: true
            }, archivePath, tempDirectory)
        } catch (error) {
            if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
            throw error
        } finally {
            this.archiving = false
        }
    }

    async readChunk(id: string, offset: number): Promise<HostDownloadChunkResponse> {
        const download = this.downloads.get(id)
        if (!download) return { success: false, error: 'Download is no longer available' }
        if (offset > download.size) return { success: false, error: 'Invalid download offset' }
        const remaining = download.size - offset
        if (remaining === 0) return { success: true, base64: '', nextOffset: offset, done: true }
        const handle = download.handle ?? await open(download.path, 'r')
        try {
            if (download.handle) {
                const currentInfo = await handle.stat()
                if (!currentInfo.isFile() || currentInfo.size !== download.size) {
                    return { success: false, error: 'Download changed while being read' }
                }
            }
            const bytes = Math.min(CHUNK_BYTES, remaining)
            const buffer = Buffer.allocUnsafe(bytes)
            const { bytesRead } = await handle.read(buffer, 0, bytes, offset)
            if (bytesRead === 0) {
                return { success: false, error: 'Download changed while being read' }
            }
            const nextOffset = offset + bytesRead
            return {
                success: true,
                base64: buffer.subarray(0, bytesRead).toString('base64'),
                nextOffset,
                done: nextOffset >= download.size
            }
        } finally {
            if (!download.handle) await handle.close()
        }
    }

    async release(id: string): Promise<void> {
        const download = this.downloads.get(id)
        if (!download) return
        this.downloads.delete(id)
        clearTimeout(download.timer)
        if (download.handle) await download.handle.close()
        if (download.tempDirectory) await rm(download.tempDirectory, { recursive: true, force: true })
    }

    private register(
        descriptor: Omit<HostDownloadDescriptor, 'id'> & { id: string },
        path: string,
        tempDirectory?: string,
        handle?: FileHandle
    ): HostDownloadDescriptor {
        const timer = setTimeout(() => { void this.release(descriptor.id) }, DOWNLOAD_TTL_MS)
        timer.unref()
        this.downloads.set(descriptor.id, { ...descriptor, path, tempDirectory, handle, timer })
        return descriptor
    }
}

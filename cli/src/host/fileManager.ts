import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import { MAX_HOST_FILE_UPLOAD_BYTES } from '@hapi/protocol'
import type {
    FileOperation,
    HostFileEntry,
    HostFilePreviewResponse,
    HostFileUploadRequest,
    HostFileUploadResponse,
    HostFileWriteRequest,
    HostListDirectoryResponse
} from '@hapi/protocol'
import type { HostOperationContext } from './hostOperationManager'
import { WorkspaceScope } from './workspaceScope'

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

function isDescendant(candidate: string, parent: string): boolean {
    const rel = relative(parent, candidate)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024
const IMAGE_MIME_TYPES: Record<string, string> = {
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
}

const TEXT_EXTENSIONS = new Set([
    '.c', '.cc', '.cpp', '.css', '.csv', '.go', '.html', '.ini', '.java', '.js', '.json', '.jsx', '.md',
    '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
])

function mimeTypeFor(path: string): string {
    const extension = extname(path).toLowerCase()
    if (IMAGE_MIME_TYPES[extension]) return IMAGE_MIME_TYPES[extension]
    if (extension === '.json') return 'application/json'
    if (extension === '.pdf') return 'application/pdf'
    return TEXT_EXTENSIONS.has(extension) ? 'text/plain' : 'application/octet-stream'
}

function isTextPreview(path: string, bytes: Uint8Array): boolean {
    if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return true
    return !bytes.includes(0)
}

async function nextCopyPath(directory: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const extension = dot > 0 ? name.slice(dot) : ''
    for (let index = 1; index < 10_000; index += 1) {
        const suffix = index === 1 ? ' (copy)' : ` (copy ${index})`
        const candidate = join(directory, `${stem}${suffix}${extension}`)
        if (!(await pathExists(candidate))) return candidate
    }
    throw new Error(`Unable to create a unique copy of ${name}`)
}

function decodeUploadBase64(value: string): Buffer {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error('Upload content is not valid base64')
    }
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length > MAX_HOST_FILE_UPLOAD_BYTES) {
        throw new Error('File too large (max 20 MiB)')
    }
    return bytes
}

export class FileManager {
    constructor(private readonly scope: WorkspaceScope) {}

    async list(path: string, includeHidden = false): Promise<HostListDirectoryResponse> {
        const directory = await this.scope.resolveReadable(path)
        const directoryStat = await stat(directory)
        if (!directoryStat.isDirectory()) {
            throw new Error('Path is not a directory')
        }

        const entries = await readdir(directory, { withFileTypes: true })
        const result = await Promise.all(entries
            .filter((entry) => includeHidden || !entry.name.startsWith('.'))
            .map(async (entry): Promise<HostFileEntry> => {
                const fullPath = join(directory, entry.name)
                const info = await lstat(fullPath)
                const type = entry.isSymbolicLink()
                    ? 'symlink' as const
                    : entry.isDirectory()
                        ? 'directory' as const
                        : entry.isFile()
                            ? 'file' as const
                            : 'other' as const
                let isGitRepo = false
                if (type === 'directory') {
                    try {
                        isGitRepo = await pathExists(join(fullPath, '.git'))
                    } catch {
                        isGitRepo = false
                    }
                }
                return {
                    name: entry.name,
                    path: fullPath,
                    type,
                    size: info.size,
                    modified: info.mtimeMs,
                    hidden: entry.name.startsWith('.'),
                    ...(isGitRepo ? { isGitRepo: true } : {})
                }
            }))

        result.sort((left, right) => {
            if (left.type === 'directory' && right.type !== 'directory') return -1
            if (left.type !== 'directory' && right.type === 'directory') return 1
            return left.name.localeCompare(right.name)
        })
        return { success: true, path: directory, entries: result }
    }

    async readPreview(rawPath: string): Promise<HostFilePreviewResponse> {
        const path = await this.scope.resolveReadable(rawPath)
        const info = await stat(path)
        if (!info.isFile()) throw new Error('Path is not a file')
        const base = {
            success: true as const,
            path,
            name: basename(path),
            mimeType: mimeTypeFor(path),
            size: info.size,
            modified: Math.round(info.mtimeMs)
        }
        if (info.size > MAX_PREVIEW_BYTES) {
            return { ...base, kind: 'binary' }
        }
        const bytes = await readFile(path)
        if (base.mimeType.startsWith('image/')) {
            return { ...base, kind: 'image', base64: bytes.toString('base64') }
        }
        if (!isTextPreview(path, bytes)) {
            return { ...base, kind: 'binary' }
        }
        return { ...base, kind: 'text', text: bytes.toString('utf8') }
    }

    async writeText(request: HostFileWriteRequest): Promise<HostFilePreviewResponse> {
        const path = await this.scope.resolveMutableExisting(request.path)
        const info = await stat(path)
        if (!info.isFile()) throw new Error('Path is not a file')
        const modified = Math.round(info.mtimeMs)
        if ((request.expectedModified !== undefined && request.expectedModified !== modified)
            || (request.expectedSize !== undefined && request.expectedSize !== info.size)) {
            throw new Error('File changed since it was opened')
        }
        const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
        await writeFile(tempPath, request.content, { encoding: 'utf8', mode: info.mode & 0o777 })
        await rename(tempPath, path)
        return await this.readPreview(path)
    }

    async upload(request: HostFileUploadRequest): Promise<HostFileUploadResponse> {
        const directory = await this.scope.resolveReadable(request.directory)
        const directoryInfo = await stat(directory)
        if (!directoryInfo.isDirectory()) throw new Error('Upload destination is not a directory')
        const bytes = decodeUploadBase64(request.contentBase64)
        let target = await this.scope.resolveDestination(join(directory, request.name))
        let replaced = false

        if (await pathExists(target)) {
            if (request.conflict === 'skip') {
                return { success: true, path: target, skipped: true }
            }
            if (request.conflict === 'fail') {
                throw new Error('Destination already exists: ' + target)
            }
            if (request.conflict === 'new-copy') {
                target = await this.scope.resolveDestination(await nextCopyPath(directory, request.name))
            } else {
                const existing = await this.scope.resolveMutableExisting(target)
                if (!(await lstat(existing)).isFile()) {
                    throw new Error('Upload cannot replace a directory')
                }
                replaced = true
            }
        }

        if (!replaced) {
            const handle = await open(target, 'wx', 0o600)
            try {
                await handle.writeFile(bytes)
            } finally {
                await handle.close()
            }
        } else {
            const tempPath = join(dirname(target), '.' + basename(target) + '.' + randomUUID() + '.upload')
            await writeFile(tempPath, bytes, { mode: 0o600 })
            await rename(tempPath, target)
        }

        return { success: true, path: target, size: bytes.length, replaced: replaced || undefined }
    }

    async lockKeys(operation: FileOperation): Promise<string[]> {
        switch (operation.kind) {
            case 'create-file':
            case 'create-directory':
                return [await this.scope.resolveDestination(operation.path)]
            case 'copy':
            case 'move':
                return [
                    ...await Promise.all(operation.sources.map((path) => this.scope.resolveMutableExisting(path))),
                    operation.createDestination
                        ? await this.scope.resolveDestination(operation.destination)
                        : await this.scope.resolveReadable(operation.destination)
                ]
            case 'delete':
                return await Promise.all(operation.paths.map((path) => this.scope.resolveMutableExisting(path)))
        }
    }

    async execute(operation: FileOperation, context: HostOperationContext): Promise<Record<string, unknown>> {
        switch (operation.kind) {
            case 'create-file': {
                const path = await this.scope.resolveDestination(operation.path)
                const handle = await open(path, 'wx', 0o600)
                try {
                    await handle.writeFile(operation.content ?? '', 'utf8')
                } finally {
                    await handle.close()
                }
                return { paths: [path] }
            }
            case 'create-directory': {
                const path = await this.scope.resolveDestination(operation.path)
                await mkdir(path)
                return { paths: [path] }
            }
            case 'copy':
                return await this.copyOrMove(operation, context, false)
            case 'move':
                return await this.copyOrMove(operation, context, true)
            case 'delete': {
                const deleted: string[] = []
                for (let index = 0; index < operation.paths.length; index += 1) {
                    if (context.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
                    const path = await this.scope.resolveMutableExisting(operation.paths[index])
                    context.report(index / operation.paths.length, `Deleting ${basename(path)}`)
                    await rm(path, { recursive: true, force: false })
                    deleted.push(path)
                }
                return { paths: deleted }
            }
        }
    }

    private async copyOrMove(
        operation: Extract<FileOperation, { kind: 'copy' | 'move' }>,
        context: HostOperationContext,
        move: boolean
    ): Promise<Record<string, unknown>> {
        let destinationDirectory: string
        try {
            destinationDirectory = await this.scope.resolveReadable(operation.destination)
        } catch (error) {
            if (!operation.createDestination || !(error instanceof Error && error.message === 'Path does not exist')) throw error
            destinationDirectory = await this.scope.resolveDestination(operation.destination)
            await mkdir(destinationDirectory, { recursive: true })
        }
        const destinationStat = await stat(destinationDirectory)
        if (!destinationStat.isDirectory()) throw new Error('Destination is not a directory')

        const plans = await Promise.all(operation.sources.map(async (rawSource) => {
            const source = await this.scope.resolveMutableExisting(rawSource)
            const target = await this.scope.resolveDestination(join(destinationDirectory, basename(source)))
            const sourceInfo = await lstat(source)
            if (sourceInfo.isDirectory() && isDescendant(target, source)) {
                throw new Error('A directory cannot be copied or moved into itself')
            }
            return { source, target, sourceInfo }
        }))
        const duplicateTargets = plans.filter((plan, index) => plans.findIndex((candidate) => candidate.target === plan.target) !== index)
        if (duplicateTargets.length > 0) throw new Error(`Multiple sources have the same destination name: ${basename(duplicateTargets[0].target)}`)
        const conflicts = (await Promise.all(plans.map(async (plan) => await pathExists(plan.target) ? plan.target : null))).filter(
            (target): target is string => target !== null
        )
        // Detect every collision before changing anything. A failed preflight
        // must never leave an earlier source copied while a later one failed.
        if (operation.conflict === 'fail' && conflicts.length > 0) {
            throw new Error(`Destination already exists: ${conflicts.join(', ')}`)
        }

        const completed: string[] = []
        const replaced: string[] = []
        const skipped: string[] = []
        for (let index = 0; index < plans.length; index += 1) {
            if (context.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
            const { source } = plans[index]
            let target = plans[index].target

            // A copy dialog defaults to the current directory. Treat its
            // same-path "new copy" choice as a real duplicate instead of
            // rejecting it before the selected conflict policy can apply.
            // For replace/skip there is nothing safe to change at that path.
            if (source === target) {
                if (operation.conflict === 'new-copy') {
                    target = await this.scope.resolveDestination(await nextCopyPath(destinationDirectory, basename(source)))
                } else if (operation.conflict === 'replace' || operation.conflict === 'skip') {
                    skipped.push(source)
                    continue
                }
            }
            if (await pathExists(target)) {
                if (operation.conflict === 'skip') {
                    skipped.push(target)
                    continue
                }
                if (operation.conflict === 'new-copy') {
                    target = await this.scope.resolveDestination(await nextCopyPath(destinationDirectory, basename(source)))
                } else if (operation.conflict === 'replace') {
                    const mutableTarget = await this.scope.resolveMutableExisting(target)
                    await rm(mutableTarget, { recursive: true, force: false })
                    replaced.push(target)
                }
            }

            context.report(index / operation.sources.length, `${move ? 'Moving' : 'Copying'} ${basename(source)}`)
            if (move) {
                try {
                    await rename(source, target)
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
                    await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false })
                    await rm(source, { recursive: true, force: false })
                }
            } else {
                await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false })
            }
            completed.push(target)
        }
        return { paths: completed, replaced, skipped }
    }
}

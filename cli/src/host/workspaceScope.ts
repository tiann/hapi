import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class WorkspaceScopeError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'WorkspaceScopeError'
    }
}

function normalizeForComparison(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
}

function isWithin(path: string, root: string): boolean {
    const normalizedPath = normalizeForComparison(path)
    const normalizedRoot = normalizeForComparison(root)
    const rel = relative(normalizedRoot, normalizedPath)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function canonicalizeMissingPath(path: string): Promise<string> {
    const absolute = resolve(path)
    try {
        return await realpath(absolute)
    } catch {
        const missing: string[] = []
        let cursor = absolute
        while (cursor !== dirname(cursor)) {
            missing.unshift(basename(cursor))
            cursor = dirname(cursor)
            try {
                return join(await realpath(cursor), ...missing)
            } catch {
                // Continue to the nearest existing ancestor.
            }
        }
        return absolute
    }
}

export class WorkspaceScope {
    readonly roots: readonly string[]

    private constructor(roots: string[]) {
        this.roots = roots
    }

    static async create(workspaceRoots?: string[]): Promise<WorkspaceScope> {
        if (!workspaceRoots?.length) {
            throw new WorkspaceScopeError('Workspace management is not enabled for this machine')
        }

        const roots = Array.from(new Set(await Promise.all(workspaceRoots.map(async (root) => {
            const absolute = resolve(root)
            try {
                return await realpath(absolute)
            } catch {
                return absolute
            }
        }))))

        return new WorkspaceScope(roots)
    }

    async resolveReadable(rawPath: string): Promise<string> {
        const absolute = this.toAbsolute(rawPath)
        let canonical: string
        try {
            canonical = await realpath(absolute)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            throw new WorkspaceScopeError(code === 'ENOENT' ? 'Path does not exist' : 'Path cannot be accessed')
        }
        this.assertWithin(canonical)
        return canonical
    }

    async resolveReadableNonGitMetadata(rawPath: string): Promise<string> {
        const absolute = this.toAbsolute(rawPath)
        this.assertNoGitMetadataSegment(absolute)
        const canonical = await this.resolveReadable(absolute)
        this.assertNoGitMetadataSegment(canonical)
        return canonical
    }

    async resolveMutableExisting(rawPath: string): Promise<string> {
        const absolute = this.toAbsolute(rawPath)
        this.assertNoGitMetadataSegment(absolute)
        if (this.roots.some((root) => normalizeForComparison(root) === normalizeForComparison(absolute))) {
            throw new WorkspaceScopeError('Workspace roots cannot be modified')
        }
        const canonicalParent = await this.resolveReadable(dirname(absolute))
        const candidate = join(canonicalParent, basename(absolute))
        this.assertWithin(candidate)
        try {
            await lstat(candidate)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            throw new WorkspaceScopeError(code === 'ENOENT' ? 'Path does not exist' : 'Path cannot be accessed')
        }
        this.assertMutable(candidate)
        return candidate
    }

    async resolveWritableExisting(rawPath: string): Promise<string> {
        const canonical = await this.resolveReadableNonGitMetadata(rawPath)
        this.assertMutable(canonical)
        return canonical
    }

    async resolveDestination(rawPath: string): Promise<string> {
        const absolute = this.toAbsolute(rawPath)
        this.assertNoGitMetadataSegment(absolute)
        const canonical = await canonicalizeMissingPath(absolute)
        this.assertWithin(canonical)
        this.assertMutable(canonical)
        return canonical
    }

    assertWithin(path: string): void {
        if (!this.roots.some((root) => isWithin(path, root))) {
            throw new WorkspaceScopeError('Path is outside configured workspace roots')
        }
    }

    assertMutable(path: string): void {
        const root = this.roots.find((candidate) => isWithin(path, candidate))
        if (!root) {
            throw new WorkspaceScopeError('Path is outside configured workspace roots')
        }

        const rel = relative(normalizeForComparison(root), normalizeForComparison(path))
        if (rel === '') {
            throw new WorkspaceScopeError('Workspace roots cannot be modified')
        }
        if (rel.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git')) {
            throw new WorkspaceScopeError('Git metadata must be managed through Git operations')
        }
    }

    private toAbsolute(rawPath: string): string {
        const trimmed = rawPath.trim()
        if (!trimmed) {
            throw new WorkspaceScopeError('Path is required')
        }
        return isAbsolute(trimmed) ? resolve(trimmed) : resolve(this.roots[0], trimmed)
    }

    private assertNoGitMetadataSegment(path: string): void {
        if (path.split(/[\\/]+/).some((segment) => segment.toLowerCase() === '.git')) {
            throw new WorkspaceScopeError('Git metadata must be managed through Git operations')
        }
    }
}

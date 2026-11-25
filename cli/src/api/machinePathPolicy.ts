import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'node:path'

export function normalizeWindowsDriveRoot(path: string): string {
    return /^[A-Za-z]:$/.test(path) ? `${path}\\` : path
}

function canonicalizeExistingPathSync(path: string): string {
    return normalizeWindowsDriveRoot(realpathSync.native(path))
}

function normalizeRoots(paths: readonly string[]): string[] {
    return Array.from(new Set(paths.map((path) => {
        try {
            return canonicalizeExistingPathSync(path)
        } catch {
            return normalizeWindowsDriveRoot(resolve(path))
        }
    })))
}

function isPathWithinRoots(path: string, roots: readonly string[]): boolean {
    return roots.some((root) => {
        const child = relative(root, path)
        return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
    })
}

/**
 * Single authority for machine-scoped path access.
 *
 * Browsing and spawning share the same boundaries. Without explicit workspace
 * roots, both can access any path available to the runner's OS account; a
 * client's initial directory is a navigation preference, not an access limit.
 */
export class MachinePathPolicy {
    readonly workspaceRoots: readonly string[]

    constructor(options: {
        workspaceRoots?: readonly string[]
    } = {}) {
        this.workspaceRoots = normalizeRoots(options.workspaceRoots ?? [])
    }

    hasWorkspaceRoots(): boolean {
        return this.workspaceRoots.length > 0
    }

    isWithinSpawnRoots(path: string): boolean {
        return !this.hasWorkspaceRoots() || isPathWithinRoots(path, this.workspaceRoots)
    }

    isWithinBrowseRoots(path: string): boolean {
        return this.isWithinSpawnRoots(path)
    }

    async resolveForCheck(path: string): Promise<string> {
        const absolute = resolve(path)
        try {
            return normalizeWindowsDriveRoot(await realpath(absolute))
        } catch {
            const missing: string[] = []
            let cursor = absolute
            while (cursor !== dirname(cursor)) {
                missing.unshift(basename(cursor))
                cursor = dirname(cursor)
                try {
                    return join(normalizeWindowsDriveRoot(await realpath(cursor)), ...missing)
                } catch {
                    // Continue to the nearest existing ancestor. This resolves
                    // symlinks in the existing prefix before adding a missing tail.
                }
            }
            return normalizeWindowsDriveRoot(absolute)
        }
    }

    async allowsSpawn(path: string): Promise<boolean> {
        return this.isWithinSpawnRoots(await this.resolveForCheck(path))
    }

    async allowsBrowse(path: string): Promise<boolean> {
        return this.isWithinBrowseRoots(await this.resolveForCheck(path))
    }
}

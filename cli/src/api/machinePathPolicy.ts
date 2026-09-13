import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
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
        return child === '' || (!child.startsWith('..') && !isAbsolute(child))
    })
}

/**
 * Single authority for machine-scoped path access.
 *
 * Spawn paths are unrestricted when the runner has no configured workspace
 * roots, preserving the legacy manual-entry contract. Browse paths instead
 * fall back to the runner's home directory so native autocomplete/pickers can
 * remain useful without exposing the whole filesystem.
 */
export class MachinePathPolicy {
    readonly workspaceRoots: readonly string[]
    readonly browseRoots: readonly string[]

    constructor(options: {
        workspaceRoots?: readonly string[]
        homeDirectory?: string
    } = {}) {
        this.workspaceRoots = normalizeRoots(options.workspaceRoots ?? [])
        this.browseRoots = this.workspaceRoots.length > 0
            ? this.workspaceRoots
            : normalizeRoots([options.homeDirectory ?? homedir()])
    }

    hasWorkspaceRoots(): boolean {
        return this.workspaceRoots.length > 0
    }

    isWithinSpawnRoots(path: string): boolean {
        return !this.hasWorkspaceRoots() || isPathWithinRoots(path, this.workspaceRoots)
    }

    isWithinBrowseRoots(path: string): boolean {
        return isPathWithinRoots(path, this.browseRoots)
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

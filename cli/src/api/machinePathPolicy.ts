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

/** Roots as given, without symlink canonicalization (e.g. /tmp vs /private/tmp). */
function lexicalRoots(paths: readonly string[]): string[] {
    return Array.from(new Set(paths.map((path) => normalizeWindowsDriveRoot(resolve(path)))))
}

function isPathWithinRoots(path: string, roots: readonly string[]): boolean {
    return roots.some((root) => {
        const child = relative(root, path)
        return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
    })
}

/**
 * Default deadline for symlink resolution during access checks.
 *
 * `realpath()` rides the libuv thread pool; under system-level stalls (disk
 * sleep, power-idle throttling) it can hang for minutes, which freezes every
 * RPC that gates on path access (spawn, resume, browse) behind a hub ack
 * timeout. We prefer a responsive fallback over an unbounded wait.
 */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 3000

/**
 * Single authority for machine-scoped path access.
 *
 * Browsing and spawning share the same boundaries. Without explicit workspace
 * roots, both can access any path available to the runner's OS account; a
 * client's initial directory is a navigation preference, not an access limit.
 */
export class MachinePathPolicy {
    readonly workspaceRoots: readonly string[]
    private readonly checkRoots: readonly string[]
    private readonly resolveTimeoutMs: number

    constructor(options: {
        workspaceRoots?: readonly string[]
        /** Deadline for symlink resolution; <= 0 disables the watchdog. */
        resolveTimeoutMs?: number
    } = {}) {
        const roots = options.workspaceRoots ?? []
        this.workspaceRoots = normalizeRoots(roots)
        // Containment is checked against both canonical and lexical roots so a
        // path left unresolved by the resolution watchdog (see resolveForCheck)
        // still matches the root exactly as configured.
        this.checkRoots = [...this.workspaceRoots, ...lexicalRoots(roots)]
        this.resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS
    }

    hasWorkspaceRoots(): boolean {
        return this.workspaceRoots.length > 0
    }

    isWithinSpawnRoots(path: string): boolean {
        return !this.hasWorkspaceRoots() || isPathWithinRoots(path, this.checkRoots)
    }

    isWithinBrowseRoots(path: string): boolean {
        return this.isWithinSpawnRoots(path)
    }

    async resolveForCheck(path: string): Promise<string> {
        const absolute = normalizeWindowsDriveRoot(resolve(path))
        const work = this.resolveSymlinks(absolute)
        if (this.resolveTimeoutMs <= 0) {
            return work
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<null>((fulfill) => {
            timer = setTimeout(() => fulfill(null), this.resolveTimeoutMs)
        })
        try {
            // resolveSymlinks never rejects; a timeout degrades to the
            // unresolved path rather than hanging the calling RPC. Symlink
            // indirection is accepted for that rare window in exchange for
            // staying responsive while the filesystem is stalled.
            return (await Promise.race([work, timedOut])) ?? absolute
        } finally {
            clearTimeout(timer)
        }
    }

    /** Resolve symlinks in the existing prefix, appending any missing tail. */
    private async resolveSymlinks(absolute: string): Promise<string> {
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

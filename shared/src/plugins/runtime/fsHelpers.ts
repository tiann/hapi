import { lstat, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { HAPI_PLUGIN_MANIFEST_FILE } from '../manifest'
import { expandHomePath } from '../foundation'
import type { PluginLocalDirectoryEntry, PluginLocalDirectoryListResponse } from '../admin'

export async function safePathExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

export function isPathInside(parentPath: string, childPath: string): boolean {
    const rel = relative(parentPath, childPath)
    return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

export function sortLocalDirectoryEntries<T extends { name: string; type: string }>(entries: T[]): T[] {
    return entries.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1
        if (left.type !== 'directory' && right.type === 'directory') return 1
        return left.name.localeCompare(right.name)
    })
}

export async function listPluginLocalDirectory(path: string | undefined, defaultPath: string): Promise<PluginLocalDirectoryListResponse> {
    const requestedPath = path?.trim() ? path.trim() : defaultPath
    const resolvedPath = resolve(expandHomePath(requestedPath))
    try {
        const stats = await lstat(resolvedPath)
        if (!stats.isDirectory()) {
            return {
                success: false,
                path: resolvedPath,
                error: `Path is not a directory: ${resolvedPath}`
            }
        }

        const [entries, hasPluginManifest] = await Promise.all([
            readdir(resolvedPath, { withFileTypes: true }),
            safePathExists(join(resolvedPath, HAPI_PLUGIN_MANIFEST_FILE))
        ])

        const mapped = await Promise.all(entries.map(async (entry): Promise<PluginLocalDirectoryEntry> => {
            const entryPath = join(resolvedPath, entry.name)
            const entryStats = await lstat(entryPath).catch(() => null)
            const type: PluginLocalDirectoryEntry['type'] = entry.isDirectory()
                ? 'directory'
                : entry.isFile()
                    ? 'file'
                    : 'other'
            return {
                name: entry.name,
                type,
                ...(entryStats ? { size: entryStats.size, modified: entryStats.mtimeMs } : {}),
                ...(type === 'directory' ? { hasPluginManifest: await safePathExists(join(entryPath, HAPI_PLUGIN_MANIFEST_FILE)) } : {})
            }
        }))

        return {
            success: true,
            path: resolvedPath,
            parentPath: dirname(resolvedPath),
            hasPluginManifest,
            entries: sortLocalDirectoryEntries(mapped)
        }
    } catch (error) {
        return {
            success: false,
            path: resolvedPath,
            error: error instanceof Error ? error.message : String(error)
        }
    }
}

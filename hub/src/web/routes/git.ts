import { Hono } from 'hono'
import { isWildcardSearch, matchesSearchQuery, toSearchGlob } from '@hapi/protocol'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const directorySchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const generatedImageSchema = z.object({
    imageId: z.string().min(1)
})

function normalizeFileSearchPath(path: string): string {
    return path.replaceAll('\\', '/')
}

function isWindowsSessionPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function hasPathSeparator(query: string, windowsSession: boolean): boolean {
    return query.includes('/') || (windowsSession && query.includes('\\'))
}

function normalizeSearchPath(path: string, windowsSession: boolean): string {
    return windowsSession ? path.replaceAll('\\', '/') : path
}

function trimTrailingSeparators(path: string): string {
    if (path === '/' || /^[A-Za-z]:\/$/.test(path)) {
        return path
    }
    return path.replace(/\/+$/, '')
}

function isAbsoluteSearchPath(path: string, windowsSession: boolean): boolean {
    return path.startsWith('/') || (windowsSession && (/^[A-Za-z]:\//.test(path) || path.startsWith('//')))
}

function pathsEqual(left: string, right: string, caseInsensitive: boolean): boolean {
    return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

function pathStartsWith(left: string, prefix: string, caseInsensitive: boolean): boolean {
    const normalizedLeft = caseInsensitive ? left.toLowerCase() : left
    const normalizedPrefix = caseInsensitive ? prefix.toLowerCase() : prefix
    return normalizedLeft.startsWith(normalizedPrefix)
}

function normalizeRelativeSearchPath(path: string, allowEmpty = false): string | null {
    const parts: string[] = []
    for (const part of path.split('/')) {
        if (!part || part === '.') {
            continue
        }
        if (part === '..') {
            if (parts.length === 0) {
                return null
            }
            parts.pop()
            continue
        }
        parts.push(part)
    }
    return parts.length > 0 ? parts.join('/') : allowEmpty ? '' : null
}

/**
 * Return a workspace-relative path for strict path queries.
 * `undefined` means the query should keep using fuzzy search; `null` means it
 * looked like a path but cannot identify a path inside the session workspace.
 */
function resolveWorkspaceRelativeSearchPath(
    query: string,
    sessionPath: string,
    allowEmpty: boolean
): string | null {
    const windowsSession = isWindowsSessionPath(sessionPath)
    const normalizedQuery = normalizeSearchPath(query, windowsSession)
    const normalizedSessionPath = trimTrailingSeparators(normalizeSearchPath(sessionPath, windowsSession))
    const caseInsensitive = windowsSession

    if (!isAbsoluteSearchPath(normalizedQuery, windowsSession)) {
        return normalizeRelativeSearchPath(normalizedQuery, allowEmpty)
    }

    const normalizedAbsoluteQuery = trimTrailingSeparators(normalizedQuery)
    const sessionPrefix = normalizedSessionPath.endsWith('/')
        ? normalizedSessionPath
        : `${normalizedSessionPath}/`
    if (!pathsEqual(normalizedAbsoluteQuery, normalizedSessionPath, caseInsensitive)
        && !pathStartsWith(normalizedAbsoluteQuery, sessionPrefix, caseInsensitive)) {
        return null
    }

    const relativePath = pathsEqual(normalizedAbsoluteQuery, normalizedSessionPath, caseInsensitive)
        ? ''
        : normalizedAbsoluteQuery.slice(sessionPrefix.length)
    return normalizeRelativeSearchPath(relativePath, allowEmpty)
}

function getDirectorySearchPath(query: string, sessionPath: string): string | null | undefined {
    const windowsSession = isWindowsSessionPath(sessionPath)
    if (isWildcardSearch(query) || !hasPathSeparator(query, windowsSession)) {
        return undefined
    }

    const normalizedQuery = normalizeSearchPath(query, windowsSession)
    if (!normalizedQuery.endsWith('/')) {
        return undefined
    }

    return resolveWorkspaceRelativeSearchPath(
        trimTrailingSeparators(normalizedQuery),
        sessionPath,
        true
    )
}

function getExactFileSearchPath(query: string, sessionPath: string): string | null | undefined {
    const windowsSession = isWindowsSessionPath(sessionPath)
    if (isWildcardSearch(query) || !hasPathSeparator(query, windowsSession)) {
        return undefined
    }

    const normalizedQuery = normalizeSearchPath(query, windowsSession)
    if (normalizedQuery.endsWith('/')) {
        return undefined
    }

    return resolveWorkspaceRelativeSearchPath(normalizedQuery, sessionPath, false)
}

function toFileSearchItem(fullPath: string, metadata?: { size?: number; modified?: number }) {
    const parts = fullPath.split('/')
    const fileName = parts[parts.length - 1] || fullPath
    const filePath = parts.slice(0, -1).join('/')
    return {
        fileName,
        filePath,
        fullPath,
        fileType: 'file' as const,
        size: metadata?.size,
        modified: metadata?.modified
    }
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

// Generated-image bytes for a given id never change, so they are cached for a year as immutable.
const GENERATED_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

// Weak comparison of an If-None-Match header against our ETag (handles lists, `*`, and W/ prefixes).
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false
    }
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}

export function createGitRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const result = await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionResult.sessionId, { cwd: sessionPath, staged }))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged
        }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => engine.readSessionFile(sessionResult.sessionId, parsed.data.path))
        return c.json(result)
    })

    app.get('/sessions/:id/generated-images/:imageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        // The id is an immutable content fingerprint, so it doubles as the ETag. If the client
        // already holds it, answer 304 *before* the RPC so revalidation skips the CLI round-trip
        // entirely (and still works even if the image was evicted from CLI memory). Issue #927.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        const result = await runRpc(() => engine.readGeneratedImage(sessionResult.sessionId, parsed.data.imageId))
        if (!result.success || !result.content) {
            return c.json({ success: false, error: result.error ?? 'Generated image not found' }, 404)
        }

        const bytes = Uint8Array.from(Buffer.from(result.content, 'base64'))
        const mimeType = result.mimeType ?? 'application/octet-stream'
        const disposition = !result.mimeType || mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
            ? 'inline'
            : 'attachment'
        // Generated images are content-addressed by an immutable random id, so the bytes for a
        // given id never change. Cache aggressively so remounts/scroll/session reopen don't
        // re-run the full HTTP -> socket.io RPC -> base64 round-trip every time (issue #927).
        return c.body(bytes, 200, {
            'Content-Type': mimeType,
            'Content-Disposition': `${disposition}; filename="${encodeURIComponent(result.fileName ?? 'generated-media')}"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: etag
        })
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = parsed.data.query?.trim() ?? ''
        // ripgrep's gitignore-style globs use '/' as the path separator even on Windows.
        // Accept the native separator users see in Windows paths before building the glob.
        const normalizedQuery = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath(query)
            : query
        const limit = parsed.data.limit ?? 200

        const directorySearchPath = getDirectorySearchPath(normalizedQuery, sessionPath)
        if (directorySearchPath !== undefined) {
            if (directorySearchPath === null) {
                return c.json({ success: true, files: [], pathSearch: true })
            }

            if (directorySearchPath) {
                const directoryMetadataResult = await runRpc(() => engine.statFiles(
                    sessionResult.sessionId,
                    [directorySearchPath]
                ))
                if (!directoryMetadataResult.success) {
                    return c.json({
                        success: false,
                        error: directoryMetadataResult.error ?? 'Failed to list files',
                        pathSearch: true
                    })
                }

                const directoryMetadata = directoryMetadataResult.entries?.find((entry) => (
                    entry.path === directorySearchPath && entry.type === 'directory'
                ))
                if (!directoryMetadata) {
                    return c.json({ success: true, files: [], pathSearch: true })
                }
            }

            const directoryArgs = ['--files']
            if (directorySearchPath) {
                directoryArgs.push('--', directorySearchPath)
            }
            const directoryResult = await runRpc(() => engine.runRipgrep(
                sessionResult.sessionId,
                directoryArgs,
                sessionPath,
                { query: '', limit }
            ))
            if (!directoryResult.success) {
                return c.json({
                    success: false,
                    error: directoryResult.error ?? 'Failed to list files',
                    pathSearch: true
                })
            }

            const normalizePath = isWindowsSessionPath(sessionPath)
                ? normalizeFileSearchPath
                : (path: string) => path
            const directoryPaths = (directoryResult.stdout ?? '')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map(normalizePath)
                .slice(0, limit)
            const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, directoryPaths))
            const metadataByPath = new Map(
                metadataResult.success
                    ? (metadataResult.entries ?? []).map((entry) => [entry.path, entry] as const)
                    : []
            )

            return c.json({
                success: true,
                files: directoryPaths.map((fullPath) => toFileSearchItem(fullPath, metadataByPath.get(fullPath))),
                pathSearch: true
            })
        }

        const exactFileSearchPath = getExactFileSearchPath(normalizedQuery, sessionPath)
        if (exactFileSearchPath !== undefined) {
            if (exactFileSearchPath === null) {
                return c.json({ success: true, files: [], pathSearch: true })
            }

            const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, [exactFileSearchPath]))
            if (!metadataResult.success) {
                return c.json({
                    success: false,
                    error: metadataResult.error ?? 'Failed to list files',
                    pathSearch: true
                })
            }

            const metadata = metadataResult.entries?.find((entry) => (
                entry.path === exactFileSearchPath && entry.type === 'file'
            ))
            return c.json({
                success: true,
                files: metadata ? [toFileSearchItem(exactFileSearchPath, metadata)] : [],
                pathSearch: true
            })
        }

        const args = ['--files']
        if (normalizedQuery && !isWildcardSearch(normalizedQuery)) {
            args.push('--iglob', toSearchGlob(normalizedQuery))
        }

        const result = await runRpc(() => engine.runRipgrep(
            sessionResult.sessionId,
            args,
            sessionPath,
            { query: normalizedQuery, limit }
        ))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const normalizePath = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath
            : (path: string) => path
        const paths = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map(normalizePath)
            .filter((path) => !normalizedQuery || matchesSearchQuery(path, normalizedQuery))
            .slice(0, limit)

        const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, paths))
        const metadataByPath = new Map(
            metadataResult.success
                ? (metadataResult.entries ?? []).map((entry) => [entry.path, entry] as const)
                : []
        )

        const files = paths.map((fullPath) => toFileSearchItem(fullPath, metadataByPath.get(fullPath)))

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/directory', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = directorySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const path = parsed.data.path ?? ''
        const result = await runRpc(() => engine.listDirectory(sessionResult.sessionId, path))
        return c.json(result)
    })

    return app
}

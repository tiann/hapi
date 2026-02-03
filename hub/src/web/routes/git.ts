import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const treeBrowseSchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

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
        const limit = parsed.data.limit ?? 200
        const args = ['--files']
        if (query) {
            args.push('--iglob', `*${query}*`)
        }

        const result = await runRpc(() => engine.runRipgrep(sessionResult.sessionId, args, sessionPath))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const files = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, limit)
            .map((fullPath) => {
                const parts = fullPath.split('/')
                const fileName = parts[parts.length - 1] || fullPath
                const filePath = parts.slice(0, -1).join('/')
                return {
                    fileName,
                    filePath,
                    fullPath,
                    fileType: 'file' as const
                }
            })

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/tree', async (c) => {
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

        const parsed = treeBrowseSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const subPath = parsed.data.path?.trim() ?? ''
        const cwd = subPath ? `${sessionPath}/${subPath}` : sessionPath

        const result = await runRpc(() => engine.runRipgrep(sessionResult.sessionId, ['--files', '--max-depth', '2'], cwd))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list directory' })
        }

        const stdout = result.stdout ?? ''
        const seen = new Set<string>()
        const entries: Array<{ name: string; path: string; type: 'file' | 'directory' }> = []

        for (const line of stdout.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const parts = trimmed.split('/')
            if (parts.length > 1) {
                // It's a file inside a subdirectory → the first part is a directory
                const dirName = parts[0]
                if (!seen.has(dirName)) {
                    seen.add(dirName)
                    entries.push({
                        name: dirName,
                        path: subPath ? `${subPath}/${dirName}` : dirName,
                        type: 'directory'
                    })
                }
            } else {
                const fileName = parts[0]
                if (!seen.has(fileName)) {
                    seen.add(fileName)
                    entries.push({
                        name: fileName,
                        path: subPath ? `${subPath}/${fileName}` : fileName,
                        type: 'file'
                    })
                }
            }
        }

        // Sort: directories first, then files, alphabetical within each group
        entries.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
        })

        return c.json({ success: true, entries })
    })

    return app
}

import { Hono } from 'hono'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const directoryBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().default('/')
})

const fileBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().min(1)
})

const fileMutationBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().min(1),
    content: z.string().default('')
})

const projectsBodySchema = z.object({
    machineId: z.string().min(1)
})

const gitStatusBodySchema = z.object({
    machineId: z.string().min(1),
    path: z.string().min(1)
})

export function createEditorRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/editor/directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = directoryBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listEditorDirectory(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list directory'
            }, 500)
        }
    })

    app.post('/editor/file', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = fileBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.readEditorFile(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read file'
            }, 500)
        }
    })

    app.post('/editor/file/write', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = fileMutationBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.writeEditorFile(parsed.data.machineId, parsed.data.path, parsed.data.content)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to write file'
            }, 500)
        }
    })

    app.post('/editor/file/create', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = fileMutationBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.createEditorFile(parsed.data.machineId, parsed.data.path, parsed.data.content)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create file'
            }, 500)
        }
    })

    app.post('/editor/projects', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = projectsBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listEditorProjects(parsed.data.machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list projects'
            }, 500)
        }
    })

    app.post('/editor/git-status', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = gitStatusBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.getEditorGitStatus(parsed.data.machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to get git status'
            }, 500)
        }
    })

    return app
}

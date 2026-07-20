import {
    GitInspectRequestSchema,
    MAX_HOST_FILE_UPLOAD_BYTES,
    HostListDirectoryRequestSchema,
    HostFilePreviewRequestSchema,
    HostFileUploadRequestSchema,
    HostFileWriteRequestSchema,
    HostDownloadChunkRequestSchema,
    HostDownloadPrepareRequestSchema,
    HostOperationRequestSchema,
    MachineListDirectoryRequestSchema,
    MachinePathsExistsRequestSchema,
    SpawnSessionRequestSchema
} from '@hapi/protocol'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

const HOST_REQUEST_BODY_BYTES = Math.ceil((MAX_HOST_FILE_UPLOAD_BYTES * 4) / 3) + 8192

async function readJsonBody(c: Context<WebAppEnv>): Promise<unknown> {
    try {
        return await c.req.json()
    } catch (error) {
        if (error instanceof SyntaxError) return null
        throw error
    }
}

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/machines/:id/host/*', bodyLimit({
        maxSize: HOST_REQUEST_BODY_BYTES,
        onError: (c) => c.json({ error: 'Payload too large' }, 413)
    }))

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SpawnSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined,
            parsed.data.effort,
            parsed.data.permissionMode
        )
        return c.json(result)
    })

    app.post('/machines/:id/list-directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineListDirectoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listMachineDirectory(machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to list directory' }, 500)
        }
    })

    app.post('/machines/:id/host/files/list', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostListDirectoryRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.listHostDirectory(machineId, parsed.data.path, parsed.data.includeHidden))
    })

    app.post('/machines/:id/host/files/read', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostFilePreviewRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.readHostFilePreview(machineId, parsed.data.path))
    })

    app.post('/machines/:id/host/files/write', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostFileWriteRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.writeHostFile(machineId, parsed.data))
    })

    app.post('/machines/:id/host/files/upload', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostFileUploadRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.uploadHostFile(machineId, parsed.data))
    })

    app.post('/machines/:id/host/downloads', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostDownloadPrepareRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.prepareHostDownload(machineId, parsed.data.path))
    })

    app.post('/machines/:id/host/downloads/:downloadId/chunk', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const body = await readJsonBody(c)
        const parsed = HostDownloadChunkRequestSchema.safeParse({
            ...(body && typeof body === 'object' ? body : {}),
            id: c.req.param('downloadId')
        })
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.readHostDownloadChunk(machineId, parsed.data.id, parsed.data.offset))
    })

    app.post('/machines/:id/host/downloads/:downloadId/release', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostDownloadChunkRequestSchema.pick({ id: true }).safeParse({ id: c.req.param('downloadId') })
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        await engine.releaseHostDownload(machineId, parsed.data.id)
        return c.json({ success: true })
    })

    app.post('/machines/:id/host/git/inspect', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = GitInspectRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.inspectHostGit(machineId, parsed.data.path))
    })

    app.post('/machines/:id/host/operations', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        const parsed = HostOperationRequestSchema.safeParse(await readJsonBody(c))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        return c.json(await engine.startHostOperation(machineId, parsed.data))
    })

    app.get('/machines/:id/host/operations/:operationId', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        return c.json(await engine.getHostOperation(machineId, c.req.param('operationId')))
    })

    app.post('/machines/:id/host/operations/:operationId/cancel', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        return c.json(await engine.cancelHostOperation(machineId, c.req.param('operationId')))
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachinePathsExistsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    app.get('/machines/:id/codex-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCodexModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForCwd(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/machines/:id/grok-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            return c.json(await engine.listGrokModelsForCwd(machineId, cwd))
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Grok models'
            }, 500)
        }
    })

    app.get('/machines/:id/cursor-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCursorModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    return app
}

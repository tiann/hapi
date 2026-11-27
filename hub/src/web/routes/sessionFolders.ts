import {
    CreateSessionFolderRequestSchema,
    SetSessionFolderRequestSchema
} from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { SSEManager } from '../../sse/sseManager'
import type { SessionFolderStore } from '../../store/sessionFolderStore'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createSessionFoldersRoutes(
    folders: SessionFolderStore,
    getSyncEngine: () => SyncEngine | null,
    getSseManager: () => SSEManager | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const notify = (namespace: string) => getSseManager()?.broadcast({ type: 'session-folders-updated', namespace })

    app.get('/session-folders', (c) => c.json(folders.list(c.get('namespace'))))

    app.post('/session-folders', async (c) => {
        const parsed = CreateSessionFolderRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid folder name or parent' }, 400)

        const namespace = c.get('namespace')
        const result = folders.create(namespace, parsed.data)
        if (result.status !== 'created') {
            return result.status === 'duplicate-name'
                ? c.json({ error: 'A folder with that name already exists here.' }, 409)
                : c.json({ error: 'Parent folder not found' }, 404)
        }

        notify(namespace)
        return c.json({ folder: result.folder }, 201)
    })

    app.delete('/session-folders/:id', (c) => {
        const namespace = c.get('namespace')
        if (!folders.delete(namespace, c.req.param('id'))) return c.json({ error: 'Folder not found' }, 404)

        notify(namespace)
        return c.json({ ok: true })
    })

    app.put('/sessions/:id/folder', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const parsed = SetSessionFolderRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid folder ID' }, 400)

        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session

        const namespace = c.get('namespace')
        if (!folders.setAssignment(namespace, session.sessionId, parsed.data.folderId)) {
            return c.json({ error: 'Folder not found' }, 404)
        }

        notify(namespace)
        return c.json({ ok: true })
    })

    return app
}

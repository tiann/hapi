import { expect, it } from 'bun:test'
import type { CreateSessionFolderResponse, SessionFoldersResponse, SyncEvent } from '@hapi/protocol'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { SSEManager } from '../../sse/sseManager'
import { Store } from '../../store'
import type { EventPublisher } from '../../sync/eventPublisher'
import { SessionCache } from '../../sync/sessionCache'
import { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionFoldersRoutes } from './sessionFolders'

it('persists nested folders and keeps their chats when removing a folder from an upgraded hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-session-folders-'))
    const path = join(dir, 'hub.db')
    const initial = new Store(path)
    const alice = initial.sessions.getOrCreateSession('alice-chat', { path: '/chat', host: 'host' }, null, 'alice')
    const bob = initial.sessions.getOrCreateSession('bob-chat', { path: '/chat', host: 'host' }, null, 'bob')
    const message = initial.messages.addMessage(alice.id, { role: 'user', content: 'existing chat' }, 'test')
    initial.close()
    const legacy = new Database(path)
    legacy.exec('DROP TABLE session_folder_assignments; DROP TABLE session_folders; PRAGMA user_version = 36;')
    legacy.close()
    let store = new Store(path)
    const events: SyncEvent[] = []
    const sse = {
        broadcast: (event: SyncEvent) => {
            if (event.type === 'session-folders-updated') events.push(event)
        }
    } as unknown as SSEManager
    let engine = new SyncEngine(store, {} as never, new RpcRegistry(), sse)

    const makeApp = () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', c.req.header('test-namespace') ?? 'alice')
            await next()
        })
        return app.route('/api', createSessionFoldersRoutes(store.sessionFolders, () => engine, () => sse))
    }
    let app = makeApp()
    const request = (path: string, method = 'GET', body?: unknown, namespace = 'alice') =>
        app.request(`/api${path}`, {
            method,
            headers: { 'content-type': 'application/json', 'test-namespace': namespace },
            body: JSON.stringify(body)
        })
    const get = async (namespace = 'alice') => {
        const response = await request('/session-folders', 'GET', undefined, namespace)
        expect(response.status).toBe(200)
        return await response.json() as SessionFoldersResponse
    }
    const create = async (name: string, parentId: string | null) => {
        const response = await request('/session-folders', 'POST', { name, parentId })
        expect(response.status).toBe(201)
        return (await response.json() as CreateSessionFolderResponse).folder
    }
    const assign = (sessionId: string, folderId: string | null, namespace = 'alice') =>
        request(`/sessions/${sessionId}/folder`, 'PUT', { folderId }, namespace)

    try {
        expect(await get()).toEqual({ folders: [], assignments: {} })
        expect(store.sessions.getSession(alice.id)).not.toBeNull()
        expect((await request('/session-folders', 'POST', { name: ' ', parentId: null })).status).toBe(400)
        const parent = await create(' Work ', null)
        const child = await create('Current', parent.id)
        const other = await create('Personal', null)
        expect(parent.name).toBe('Work')
        expect((await request('/session-folders', 'POST', { name: 'Foreign', parentId: parent.id }, 'bob')).status).toBe(404)
        expect((await request(`/session-folders/${parent.id}`, 'DELETE', undefined, 'bob')).status).toBe(404)
        expect((await assign(alice.id, parent.id, 'bob')).status).toBe(403)
        expect((await assign(bob.id, parent.id, 'bob')).status).toBe(404)
        expect(await get('bob')).toEqual({ folders: [], assignments: {} })

        expect((await assign(alice.id, parent.id)).status).toBe(200)
        expect((await assign(alice.id, child.id)).status).toBe(200)
        expect((await assign(alice.id, null)).status).toBe(200)
        expect((await get()).assignments).toEqual({})
        expect((await assign(alice.id, child.id)).status).toBe(200)

        engine.stop()
        store.close()
        store = new Store(path)
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), sse)
        app = makeApp()
        expect(await get()).toEqual({
            folders: [child, other, parent],
            assignments: { [alice.id]: child.id }
        })
        expect((await request(`/session-folders/${parent.id}`, 'DELETE')).status).toBe(200)
        expect(await get()).toEqual({ folders: [other], assignments: {} })
        expect(store.sessions.getSession(alice.id)).not.toBeNull()
        expect(store.messages.getMessageById(alice.id, message.id)?.content).toEqual(message.content)
        expect(events).toEqual(Array.from({ length: 8 }, () => ({ type: 'session-folders-updated', namespace: 'alice' })))
    } finally {
        engine.stop()
        store.close()
        Bun.gc(true)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
})

it.each([false, true])('preserves placement when merging sessions (target filed: %s)', async (targetFiled) => {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const cache = new SessionCache(store, { emit: (event: SyncEvent) => events.push(event) } as unknown as EventPublisher)
    try {
        const source = cache.getOrCreateSession('source', { path: '/chat', host: 'host' }, null, 'alice')
        const target = cache.getOrCreateSession('target', { path: '/chat', host: 'host' }, null, 'alice')
        const sourceFolder = store.sessionFolders.create('alice', { name: 'Source', parentId: null })!
        const targetFolder = store.sessionFolders.create('alice', { name: 'Target', parentId: null })!
        expect(store.sessionFolders.setAssignment('alice', source.id, sourceFolder.id)).toBe(true)
        if (targetFiled) {
            expect(store.sessionFolders.setAssignment('alice', target.id, targetFolder.id)).toBe(true)
        }

        await cache.mergeSessions(source.id, target.id, 'alice')

        expect(store.sessions.getSession(source.id)).toBeNull()
        expect(store.sessionFolders.list('alice').assignments).toEqual({
            [target.id]: targetFiled ? targetFolder.id : sourceFolder.id
        })
        expect(events).toContainEqual({ type: 'session-folders-updated', namespace: 'alice' })
    } finally {
        store.close()
    }
})

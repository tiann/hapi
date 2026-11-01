import { expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SessionReadState, SyncEvent } from '@hapi/protocol'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'

it('shares monotonic read state over REST and namespace-scoped SSE without touching activity', async () => {
    const store = new Store(':memory:')
    const events: SyncEvent[] = []
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
    try {
        const session = engine.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'alice')
        const message = store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'answer' } } }, 'one')
        engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
        expect(engine.getSession(session.id)?.contentRevision).toBe(1)
        expect(events.some(e => e.type === 'session-updated' && e.namespace === 'alice' && e.data && 'contentRevision' in e.data && e.data.contentRevision === 1)).toBe(true)
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', c.req.header('test-namespace') ?? 'alice'); await next() })
        app.route('/api', createSessionsRoutes(() => engine))
        const send = (body: unknown, namespace = 'alice') => app.request(`/api/sessions/${session.id}/read-state`, {
            method: 'PUT', headers: { 'content-type': 'application/json', 'test-namespace': namespace }, body: JSON.stringify(body)
        })
        const at = store.sessions.getSession(session.id)!.updatedAt
        expect((await send({ type: 'read', readRevision: 1, expectedVersion: 0 }, 'bob')).status).toBe(403)
        expect((await send({ type: 'read', readRevision: -1, expectedVersion: 0 })).status).toBe(400)
        expect((await send({ type: 'read', readRevision: 9, expectedVersion: 0 })).status).toBe(400)
        const read = await send({ type: 'read', readRevision: 1, expectedVersion: 0 })
        expect(read.status).toBe(200)
        expect(((await read.json()) as { readState: SessionReadState }).readState).toEqual({ readRevision: 1, manualUnread: false, version: 1 })
        expect(engine.getSession(session.id)?.readState?.readRevision).toBe(1)
        expect(events.some(e => e.type === 'session-updated' && e.namespace === 'alice' && e.data && 'readState' in e.data && e.data.readState?.version === 1)).toBe(true)
        expect((await send({ type: 'unread', expectedVersion: 1 })).status).toBe(200)
        const stale = await send({ type: 'read', readRevision: 1, expectedVersion: 0 })
        expect(((await stale.json()) as { readState: SessionReadState }).readState.manualUnread).toBe(true)
        expect((await send({ type: 'unread', expectedVersion: 0 })).status).toBe(409)
        expect(store.sessions.getSession(session.id)?.updatedAt).toBe(at)
    } finally { engine.stop(); store.close() }
})

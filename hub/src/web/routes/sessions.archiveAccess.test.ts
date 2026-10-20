import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import { SyncEngine } from '../../sync/syncEngine'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionsRoutes } from './sessions'
import { createMessagesRoutes } from './messages'

let engine: SyncEngine | undefined
let store: Store | undefined
afterEach(() => { engine?.stop(); store?.close() })

describe('archive namespace access', () => {
    it('retains history and leaves other chats untouched when an archive is repeated', async () => {
        store = new Store(':memory:')
        const metadata = { path: '/tmp/review', host: 'localhost', flavor: 'claude', lifecycleState: 'running' }
        const target = store.sessions.getOrCreateSession('review', metadata, null, 'my-team')
        const other = store.sessions.getOrCreateSession('other', metadata, null, 'my-team')
        const note = store.messages.addMessage(target.id, { role: 'user', content: 'Keep this review result' })
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() { } } as never)
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'my-team'); await next() })
        app.route('/api', createSessionsRoutes(() => engine!))
        app.route('/api', createMessagesRoutes(() => engine!))
        const first = await app.request(`/api/sessions/${target.id}/archive`, { method: 'POST' })
        expect(first.status).toBe(200)
        const again = await app.request(`/api/sessions/${target.id}/archive`, { method: 'POST' })
        expect(await again.json()).toEqual({ ok: true, alreadyArchived: true })
        const history = await app.request(`/api/sessions/${target.id}/messages`)
        const body = await history.json() as { messages: { id: string; content: unknown }[] }
        expect(body.messages.map(message => message.id)).toEqual([note.id])
        expect(JSON.stringify(body.messages[0]?.content)).toContain('Keep this review result')
        expect(engine.getSession(target.id)?.metadata?.lifecycleState).toBe('archived')
        expect(engine.getSession(other.id)?.metadata?.lifecycleState).toBe('running')
    })

    it('rejects another namespace even for a full exact session ID', async () => {
        store = new Store(':memory:')
        const target = store.sessions.getOrCreateSession('other-chat', { path: '/tmp/review', host: 'localhost', flavor: 'claude' }, null, 'other-team')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() { } } as never)
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'my-team'); await next() })
        app.route('/api', createSessionsRoutes(() => engine!))
        const response = await app.request(`/api/sessions/${target.id}/archive`, { method: 'POST' })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Session access denied' })
        expect(engine.resolveSessionAccess(target.id, 'other-team').ok).toBe(true)
        expect(engine.getSession(target.id)?.metadata?.lifecycleState).not.toBe('archived')
    })
})

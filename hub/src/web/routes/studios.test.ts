import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createPublicStudioRoutes, createStudioRoutes, resetStudioPostRateLimitForTests } from './studios'

function createSession(store: Store, namespace = 'default', sessionId = 'session-1') {
    store.sessions.getOrCreateSession(
        `tag-${sessionId}`,
        { path: '/repo', host: 'private-host', flavor: 'codex', name: 'Private session' },
        null,
        namespace,
        undefined,
        undefined,
        undefined,
        sessionId
    )
}

function createApp(store: Store, engine: unknown) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createStudioRoutes({ store, getSyncEngine: () => engine as never }))
    app.route('/api', createPublicStudioRoutes({ store, getSyncEngine: () => engine as never }))
    return app
}

describe('studio routes', () => {
    it('limits a room even when guests rotate their client ids', async () => {
        resetStudioPostRateLimitForTests()
        const store = new Store(':memory:')
        createSession(store)
        const room = store.studios.createOrActivateRoom('session-1', 'default', 'Room', 'contribute')
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', namespace: 'default', active: true, metadata: {} } })
        }
        const app = createApp(store, engine)
        const statuses: number[] = []
        for (let index = 0; index < 61; index += 1) {
            const response = await app.request(`/api/public/studios/${room.shareToken}/posts`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ guestId: `guest-${String(index).padStart(8, '0')}`, authorName: 'Guest', kind: 'discussion', text: `post-${index}` })
            })
            statuses.push(response.status)
        }
        expect(statuses.at(-1)).toBe(429)
    })

    it('creates an isolated room and exposes a redacted public transcript', async () => {
        const store = new Store(':memory:')
        createSession(store)
        const engine = {
            resolveSessionAccess: () => ({
                ok: true,
                sessionId: 'session-1',
                session: {
                    id: 'session-1',
                    namespace: 'default',
                    active: true,
                    model: 'gpt-test',
                    metadata: { flavor: 'codex', path: '/private/repo', host: 'private-host' }
                }
            }),
            sendMessage: async () => undefined
        }
        store.messages.addMessage('session-1', { role: 'user', content: { type: 'text', text: 'Review this' } }, 'visible-user')
        store.messages.markMessagesInvoked('session-1', ['visible-user'], Date.now())
        store.messages.addMessage('session-1', { role: 'user', content: { type: 'text', text: 'Queued secret' } }, 'queued-user')
        store.messages.addMessage('session-1', { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Looks good.' } } })
        store.messages.addMessage('session-1', { role: 'agent', content: { type: 'output', data: { type: 'assistant', isMeta: true, message: { content: [{ type: 'text', text: 'Hidden meta' }] } } } })
        store.messages.addMessage('session-1', { role: 'agent', content: { type: 'output', data: { type: 'assistant', isCompactSummary: true, message: { content: [{ type: 'text', text: 'Hidden compact summary' }] } } } })
        const app = createApp(store, engine)

        const created = await app.request('/api/studios', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'session-1' })
        })
        expect(created.status).toBe(200)
        const room = (await created.json() as { room: { id: string; shareToken: string } }).room

        const publicResponse = await app.request(`/api/public/studios/${room.shareToken}`)
        expect(publicResponse.status).toBe(200)
        expect(publicResponse.headers.get('cache-control')).toContain('no-store')
        const body = await publicResponse.json() as { messages: Array<{ text: string }>; room: Record<string, unknown> }
        expect(body.messages.map((message) => message.text)).toEqual(['Review this', 'Looks good.'])
        expect(body.room).not.toHaveProperty('shareToken')
        expect(body.room).not.toHaveProperty('sessionId')
    })

    it('pages past tool-only raw rows to retain older visible conversation', async () => {
        const store = new Store(':memory:')
        createSession(store)
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', namespace: 'default', active: true, metadata: {} } })
        }
        store.messages.addMessage('session-1', { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Older visible answer' } } })
        for (let index = 0; index < 210; index += 1) {
            store.messages.addMessage('session-1', { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'exec', input: `${index}` } } })
        }
        const room = store.studios.createOrActivateRoom('session-1', 'default', 'Room', 'contribute')
        const app = createApp(store, engine)

        const response = await app.request(`/api/public/studios/${room.shareToken}`)
        const body = await response.json() as { messages: Array<{ text: string }> }
        expect(body.messages.map((message) => message.text)).toEqual(['Older visible answer'])
    })

    it('keeps guest suggestions out of the public room response', async () => {
        const store = new Store(':memory:')
        createSession(store)
        const engine = {
            resolveSessionAccess: () => ({
                ok: true,
                sessionId: 'session-1',
                session: { id: 'session-1', namespace: 'default', active: true, metadata: {} }
            })
        }
        const room = store.studios.createOrActivateRoom('session-1', 'default', 'Room', 'contribute')
        store.studios.createPost({ roomId: room.id, guestId: 'guest-a-12345678', authorName: 'A', kind: 'discussion', text: 'Visible' })
        store.studios.createPost({ roomId: room.id, guestId: 'guest-b-12345678', authorName: 'B', kind: 'suggestion', text: 'Owner only' })
        const app = createApp(store, engine)

        const response = await app.request(`/api/public/studios/${room.shareToken}`)
        const body = await response.json() as { posts: Array<{ kind: string; text: string }> }
        expect(body.posts).toHaveLength(1)
        expect(body.posts[0]).toMatchObject({ kind: 'discussion', text: 'Visible' })
    })

    it('keeps recent discussions and all suggestions independently beyond 200 mixed posts', async () => {
        const store = new Store(':memory:')
        createSession(store)
        const engine = {
            resolveSessionAccess: () => ({ ok: true, sessionId: 'session-1', session: { id: 'session-1', namespace: 'default', active: true, metadata: {} } })
        }
        const room = store.studios.createOrActivateRoom('session-1', 'default', 'Room', 'contribute')
        store.studios.createPost({ roomId: room.id, guestId: 'guest-a-12345678', authorName: 'A', kind: 'discussion', text: 'Discussion survives', createdAt: 0 })
        for (let index = 1; index <= 205; index += 1) {
            store.studios.createPost({ roomId: room.id, guestId: 'guest-b-12345678', authorName: 'B', kind: 'suggestion', text: `suggestion-${index}`, createdAt: index })
        }
        const app = createApp(store, engine)

        const publicResponse = await app.request(`/api/public/studios/${room.shareToken}`)
        const publicBody = await publicResponse.json() as { posts: Array<{ text: string }> }
        expect(publicBody.posts.map((post) => post.text)).toEqual(['Discussion survives'])

        const ownerResponse = await app.request(`/api/studios/${room.id}`)
        const ownerBody = await ownerResponse.json() as { posts: Array<{ kind: string }> }
        expect(ownerBody.posts.filter((post) => post.kind === 'suggestion')).toHaveLength(200)
    })

    it('queues a guest suggestion and submits it only through the owner decision endpoint', async () => {
        const store = new Store(':memory:')
        createSession(store)
        const sent: string[] = []
        const engine = {
            resolveSessionAccess: () => ({
                ok: true,
                sessionId: 'session-1',
                session: { id: 'session-1', namespace: 'default', active: true, metadata: {} }
            }),
            sendMessage: async (_sessionId: string, input: { text: string }) => { sent.push(input.text) }
        }
        const app = createApp(store, engine)
        const created = await app.request('/api/studios', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 'session-1' })
        })
        const room = (await created.json() as { room: { id: string; shareToken: string } }).room

        const postResponse = await app.request(`/api/public/studios/${room.shareToken}/posts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ guestId: 'guest-12345678', authorName: 'Guest', kind: 'suggestion', text: 'Run tests' })
        })
        expect(postResponse.status).toBe(201)
        const post = (await postResponse.json() as { post: { id: string; status: string } }).post
        expect(post.status).toBe('open')
        expect(sent).toEqual([])

        const decision = await app.request(`/api/studios/${room.id}/posts/${post.id}/decision`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'submit', text: 'Run the focused tests first.' })
        })
        expect(decision.status).toBe(200)
        expect(sent).toEqual(['[Studio suggestion from Guest]\nRun the focused tests first.'])
    })
})

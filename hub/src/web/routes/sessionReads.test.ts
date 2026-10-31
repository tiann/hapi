import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Store } from '../../store'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createSessionReadsRoutes } from './sessionReads'

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop() })
async function setup() {
    const store = new Store(':memory:')
    cleanup.push(() => store.close())
    const manager = new SSEManager(60000, new VisibilityTracker())
    cleanup.push(() => manager.stop())
    const secret = new TextEncoder().encode('read-state-test-secret')
    const token = await new SignJWT({ uid: 1, ns: 'default' }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createSessionReadsRoutes(store, () => manager))
    const session = store.sessions.getOrCreateSession('test', {}, null, 'default')
    const request = (body?: unknown, auth = true) => app.request('/api/session-read-state', {
        method: body === undefined ? 'GET' : 'POST',
        headers: auth ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, manager, request, id: session.id }
}
describe('session read state API', () => {
    it('requires authentication for reads and writes', async () => {
        const { request } = await setup()
        expect((await request(undefined, false)).status).toBe(401)
        expect((await request({ mutations: [] }, false)).status).toBe(401)
    })
    it('broadcasts to two clients in the namespace without leaking to another namespace', async () => {
        const { manager, request, id } = await setup()
        const events: unknown[][] = [[], [], []]
        for (let i = 0; i < 3; i++) manager.subscribe({
            id: `client-${i}`, namespace: i === 2 ? 'other' : 'default', all: true,
            send: event => { events[i]!.push(event) }, sendHeartbeat: () => {}
        })
        const response = await request({ mutations: [{ mutationId: 'request', sessionId: id, kind: 'seen', activityAt: 100, expectedVersion: 0 }] })
        expect(response.status).toBe(200)
        const snapshot = await response.json() as { states: unknown[] }
        expect(await (await request()).json()).toEqual({ states: snapshot.states })
        expect(events[0]).toEqual(events[1])
        expect(events[0]).toHaveLength(1)
        expect(events[0]![0]).toMatchObject({ type: 'session-read-state-updated', namespace: 'default', states: snapshot.states })
        expect(events[2]).toEqual([])
    })
    it('validates payloads, foreign targets, and future read positions', async () => {
        const { store, request, id } = await setup()
        for (const mutations of [[], [{ mutationId: 'request', sessionId: id, kind: 'seen', activityAt: -1, expectedVersion: 0 }],
            [{ mutationId: 'request', sessionId: id, kind: 'seen', activityAt: 100, expectedVersion: 0.5 }], Array(501).fill({})]) {
            expect((await request({ mutations })).status).toBe(400)
        }
        const foreign = store.sessions.getOrCreateSession('other', {}, null, 'other')
        expect((await request({ mutations: [{ mutationId: 'request', sessionId: foreign.id, kind: 'seen', activityAt: 100, expectedVersion: 0 }] })).status).toBe(404)
        expect((await request({ mutations: [{ mutationId: 'request', sessionId: id, kind: 'seen', activityAt: Number.MAX_SAFE_INTEGER, expectedVersion: 0 }] })).status).toBe(400)
    })
})

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import type { SessionCache } from '../../sync/sessionCache'
import { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { FOLLOW_SESSION_REDIRECTS_HEADER } from '@hapi/protocol'
import { createSessionsRoutes } from './sessions'

/**
 * Job routes on a merged-away session id. Session lookup follows the durable
 * redirect to the survivor, but the `<old id>/<job key>` remap must still be
 * keyed by the id the supervisor holds — otherwise a colliding key targets the
 * survivor's own job.
 */

const OLD_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const NEW_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

async function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const cache = (engine as unknown as { sessionCache: SessionCache }).sessionCache
    const meta = { path: '/p', host: 'local', flavor: 'codex' }
    cache.getOrCreateSession('old', meta, null, 'default', undefined, undefined, undefined, OLD_ID)
    cache.getOrCreateSession('new', meta, null, 'default', undefined, undefined, undefined, NEW_ID)
    store.sessionJobs.upsert(OLD_ID, 'build', { label: 'old build', status: 'running', remaining: 5, runId: 'run-old' }, 1_000)
    store.sessionJobs.upsert(NEW_ID, 'build', { label: 'new build', status: 'running', remaining: 9, runId: 'run-new' }, 1_000)

    await cache.mergeSessions(OLD_ID, NEW_ID, 'default')

    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createSessionsRoutes(() => engine))

    const remappedKey = store.sessionJobs.list(NEW_ID).map((job) => job.key).find((key) => key !== 'build')
    return { store, engine, app, remappedKey }
}

function request(app: Hono<WebAppEnv>, method: string, path: string, body?: unknown, followRedirects = false) {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (followRedirects) headers[FOLLOW_SESSION_REDIRECTS_HEADER] = '1'
    return app.request(`http://localhost/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    })
}

describe('session detail on a merged-away id', () => {
    it('resolves to the survivor only for clients that opt in', async () => {
        const { store, engine, app } = await setup()
        try {
            const followed = await request(app, 'GET', `/sessions/${OLD_ID}`, undefined, true)
            expect(followed.status).toBe(200)
            expect(((await followed.json()) as { session: { id: string } }).session.id).toBe(NEW_ID)

            // Native clients keep live state under the requested id; they get the plain 404.
            const plain = await request(app, 'GET', `/sessions/${OLD_ID}`)
            expect(plain.status).toBe(404)
        } finally {
            engine.stop()
            store.close()
        }
    })
})

describe.each([
    ['with redirect opt-in', true],
    ['without redirect opt-in', false]
])('job routes on a merged-away session id (%s)', (_label, follow) => {
    it('keeps the merged source job under a remapped key on the survivor', async () => {
        const { store, remappedKey } = await setup()
        try {
            expect(store.sessions.getSession(OLD_ID)).toBeNull()
            expect(remappedKey).toBeDefined()
            expect(store.sessionJobs.get(NEW_ID, remappedKey!)?.runId).toBe('run-old')
        } finally {
            store.close()
        }
    })

    it('PATCH via the old id updates the remapped job, not the survivor job with the same key', async () => {
        const { store, engine, app, remappedKey } = await setup()
        try {
            const res = await request(app, 'PATCH', `/sessions/${OLD_ID}/jobs/build`, { remaining: 1, expectedRunId: 'run-old' }, follow)

            expect(res.status).toBe(200)
            expect(store.sessionJobs.get(NEW_ID, remappedKey!)?.remaining).toBe(1)
            expect(store.sessionJobs.get(NEW_ID, 'build')?.remaining).toBe(9)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('DELETE via the old id removes the remapped job only', async () => {
        const { store, engine, app, remappedKey } = await setup()
        try {
            const res = await request(app, 'DELETE', `/sessions/${OLD_ID}/jobs/build`, undefined, follow)

            expect(res.status).toBe(200)
            expect(store.sessionJobs.get(NEW_ID, remappedKey!)).toBeNull()
            expect(store.sessionJobs.get(NEW_ID, 'build')?.runId).toBe('run-new')
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('a late PUT via the old id lands on the remapped key', async () => {
        const { store, engine, app, remappedKey } = await setup()
        try {
            const res = await request(app, 'PUT', `/sessions/${OLD_ID}/jobs/build`, {
                label: 'old build', status: 'running', remaining: 2, runId: 'run-old'
            }, follow)

            expect(res.status).toBe(200)
            expect(store.sessionJobs.get(NEW_ID, remappedKey!)?.remaining).toBe(2)
            expect(store.sessionJobs.get(NEW_ID, 'build')?.runId).toBe('run-new')
            expect(store.sessionJobs.get(NEW_ID, 'build')?.remaining).toBe(9)
        } finally {
            engine.stop()
            store.close()
        }
    })
})

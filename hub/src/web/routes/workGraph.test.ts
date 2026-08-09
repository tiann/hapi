import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import { createWorkGraphRoutes } from './workGraph'
import { PROTOCOL_VERSION, WORK_GRAPH_MAX_BODY_BYTES } from '@hapi/protocol'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function authHeaders(namespace: string, userId = 1) {
    const token = await new SignJWT({ uid: userId, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function createApp(store: Store) {
    const app = new Hono<WebAppEnv>()
    app.get('/health', (c) => c.json({
        status: 'ok',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { workGraph: true }
    }))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createWorkGraphRoutes(store))
    return app
}

describe('work-graph routes', () => {
    it('advertises workGraph capability on /health without auth', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const response = await app.request('/health')
        expect(response.status).toBe(200)
        const body = await response.json() as {
            status: string
            protocolVersion: number
            capabilities?: { workGraph?: boolean }
        }
        expect(body.status).toBe('ok')
        expect(body.protocolVersion).toBe(PROTOCOL_VERSION)
        expect(body.capabilities?.workGraph).toBe(true)
    })

    it('writes and queries events within the authenticated namespace', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders('default')

        const create = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                source_kind: 'session',
                source_ref: 'sess-1',
                event_type: 'work_ad',
                related_session_id: 'sess-1',
                summary: 'Implementing ledger',
                principal: { kind: 'human', id: '1' }
            })
        })
        expect(create.status).toBe(201)
        const created = await create.json() as { event: { id: string }; inserted: boolean }
        expect(created.inserted).toBe(true)

        const list = await app.request('/api/work-graph/events?related_session_id=sess-1', {
            headers
        })
        expect(list.status).toBe(200)
        const listed = await list.json() as { events: Array<{ id: string; summary: string | null }> }
        expect(listed.events).toHaveLength(1)
        expect(listed.events[0]?.id).toBe(created.event.id)
        expect(listed.events[0]?.summary).toBe('Implementing ledger')
    })

    it('does not leak events across namespaces', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const alphaHeaders = await authHeaders('alpha')
        const betaHeaders = await authHeaders('beta')

        const create = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: { ...alphaHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
                source_kind: 'session',
                source_ref: 'sess-a',
                event_type: 'work_ad',
                related_session_id: 'sess-a',
                summary: 'alpha only',
                principal: { kind: 'human', id: '1' }
            })
        })
        const created = await create.json() as { event: { id: string } }

        const betaGet = await app.request(`/api/work-graph/events/${created.event.id}`, {
            headers: betaHeaders
        })
        expect(betaGet.status).toBe(404)

        const betaList = await app.request('/api/work-graph/events?related_session_id=sess-a', {
            headers: betaHeaders
        })
        const listed = await betaList.json() as { events: unknown[] }
        expect(listed.events).toHaveLength(0)
    })

    it('refuses agent principal without matching authenticated owner', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders('default', 1)

        const response = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                source_kind: 'session',
                source_ref: 'worker',
                event_type: 'work_ad',
                principal: { kind: 'agent', id: 'worker', on_behalf_of: '999' }
            })
        })
        expect(response.status).toBe(403)
    })

    it('idempotent POST returns existing row without duplicate', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders('default')
        const body = {
            source_kind: 'session',
            source_ref: 'sess-1',
            event_type: 'work_ad',
            related_session_id: 'sess-1',
            summary: 'once',
            idempotency_key: 'dedupe-me',
            principal: { kind: 'human', id: '1' }
        }

        const first = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(body)
        })
        expect(first.status).toBe(201)
        const firstJson = await first.json() as { event: { id: string }; inserted: boolean }

        const second = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, summary: 'retry' })
        })
        expect(second.status).toBe(200)
        const secondJson = await second.json() as { event: { id: string; summary: string | null }; inserted: boolean }
        expect(secondJson.inserted).toBe(false)
        expect(secondJson.event.id).toBe(firstJson.event.id)
        expect(secondJson.event.summary).toBe('once')
    })

    it('rejects oversized POST bodies with 413', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders('default')
        const oversized = 'x'.repeat(WORK_GRAPH_MAX_BODY_BYTES + 1)
        const response = await app.request('/api/work-graph/events', {
            method: 'POST',
            headers: {
                ...headers,
                'content-type': 'application/json',
                'content-length': String(oversized.length)
            },
            body: oversized
        })
        expect(response.status).toBe(413)
    })

    it('rejects fractional list limit with 400 (not SQLite 500)', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders('default')
        const response = await app.request(
            '/api/work-graph/events?related_session_id=sess-1&limit=1.5',
            { headers }
        )
        expect(response.status).toBe(400)
        const body = await response.json() as { error: string }
        expect(body.error).toBe('Invalid limit')
    })
})

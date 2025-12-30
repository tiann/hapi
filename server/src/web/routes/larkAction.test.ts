import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createLarkActionRoutes, buildLarkActionUrl } from './larkAction'

describe('Lark URL action', () => {
    test('rejects invalid signature', async () => {
        const app = new Hono()
        app.route('/api', createLarkActionRoutes({ getSyncEngine: () => null, actionSecret: 'secret' }))

        const url = new URL('http://localhost/api/lark/permission')
        url.searchParams.set('sessionId', 's')
        url.searchParams.set('requestId', 'r')
        url.searchParams.set('action', 'approve')
        url.searchParams.set('ts', String(Date.now()))
        url.searchParams.set('sig', 'bad')

        const res = await app.request(url.toString())
        expect(res.status).toBe(401)
    })

    test('accepts valid signature and returns 503 when engine missing', async () => {
        const app = new Hono()
        app.route('/api', createLarkActionRoutes({ getSyncEngine: () => null, actionSecret: 'secret' }))

        const url = buildLarkActionUrl({
            baseUrl: 'http://localhost',
            sessionId: 's',
            requestId: 'r',
            action: 'approve',
            ts: Date.now(),
            secret: 'secret'
        })

        const res = await app.request(url)
        expect(res.status).toBe(503)
    })
})

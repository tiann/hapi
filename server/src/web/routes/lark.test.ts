import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createLarkWebhookRoutes } from './lark'

describe('Lark webhook', () => {
    test('url_verification returns challenge when token matches', async () => {
        const app = new Hono()
        app.route('/api', createLarkWebhookRoutes({
            getSyncEngine: () => null,
            verificationToken: 'secret',
            appId: null,
            appSecret: null,
        }))

        const res = await app.request('http://localhost/api/lark/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'url_verification',
                challenge: 'abc',
                header: { token: 'secret' }
            })
        })

        expect(res.status).toBe(200)
        const json = await res.json() as any
        expect(json.challenge).toBe('abc')
    })

    test('returns 401 when verification token is configured and mismatched', async () => {
        const app = new Hono()
        app.route('/api', createLarkWebhookRoutes({
            getSyncEngine: () => null,
            verificationToken: 'secret',
            appId: null,
            appSecret: null,
        }))

        const res = await app.request('http://localhost/api/lark/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'url_verification',
                challenge: 'abc',
                header: { token: 'wrong' }
            })
        })

        expect(res.status).toBe(401)
    })

    test('url_verification without header works when no token configured', async () => {
        const app = new Hono()
        app.route('/api', createLarkWebhookRoutes({
            getSyncEngine: () => null,
            verificationToken: null,
            appId: null,
            appSecret: null,
        }))

        const res = await app.request('http://localhost/api/lark/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'url_verification',
                challenge: 'test123'
            })
        })

        expect(res.status).toBe(200)
        const json = await res.json() as any
        expect(json.challenge).toBe('test123')
    })

    test('url_verification with top-level token field', async () => {
        const app = new Hono()
        app.route('/api', createLarkWebhookRoutes({
            getSyncEngine: () => null,
            verificationToken: 'secret',
            appId: null,
            appSecret: null,
        }))

        const res = await app.request('http://localhost/api/lark/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'url_verification',
                challenge: 'test456',
                token: 'secret'
            })
        })

        expect(res.status).toBe(200)
        const json = await res.json() as any
        expect(json.challenge).toBe('test456')
    })
})

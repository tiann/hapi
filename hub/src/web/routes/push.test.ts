import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import { createPushRoutes } from './push'

const JWT_SECRET = new TextEncoder().encode('test-secret')

async function authHeaders() {
    const token = await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

function createApp(store: Store) {
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createPushRoutes(store, 'vapid-public-key'))
    return app
}

function subscription(endpoint: string, language?: string) {
    return {
        endpoint,
        keys: { p256dh: 'p256dh', auth: 'auth' },
        ...(language === undefined ? {} : { language })
    }
}

describe('push routes', () => {
    it('stores the subscription language and refreshes it on re-subscribe', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = { ...await authHeaders(), 'content-type': 'application/json' }

        const subscribe = (body: unknown) => app.request('/api/push/subscribe', {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        })

        expect((await subscribe(subscription('https://push.example/1', 'ru'))).status).toBe(200)
        expect(store.push.getPushSubscriptionsByNamespace('default')[0]?.language).toBe('ru')

        // Browsers re-subscribe on every load; the stored language must follow.
        expect((await subscribe(subscription('https://push.example/1', 'en-US'))).status).toBe(200)
        expect(store.push.getPushSubscriptionsByNamespace('default')[0]?.language).toBe('en-US')

        store.close()
    })

    it('accepts a subscription without a language and stores null', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = { ...await authHeaders(), 'content-type': 'application/json' }

        const response = await app.request('/api/push/subscribe', {
            method: 'POST',
            headers,
            body: JSON.stringify(subscription('https://push.example/2'))
        })

        expect(response.status).toBe(200)
        expect(store.push.getPushSubscriptionsByNamespace('default')[0]?.language).toBeNull()

        store.close()
    })

    it('rejects an over-long language tag', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = { ...await authHeaders(), 'content-type': 'application/json' }

        const response = await app.request('/api/push/subscribe', {
            method: 'POST',
            headers,
            body: JSON.stringify(subscription('https://push.example/3', 'x'.repeat(36)))
        })

        expect(response.status).toBe(400)
        expect(store.push.getPushSubscriptionsByNamespace('default')).toHaveLength(0)

        store.close()
    })
})

import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { createNotificationPreferencesRoutes } from './notificationPreferences'

function createApp(): Hono<WebAppEnv> {
    const store = new Store(':memory:')
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'test-ns')
        await next()
    })
    app.route('/api', createNotificationPreferencesRoutes(store))
    return app
}

describe('GET /api/notification-preferences', () => {
    it('returns all-enabled defaults for a namespace with no row', async () => {
        const app = createApp()
        const res = await app.request('/api/notification-preferences')
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
            namespace: 'test-ns',
            permissionRequests: 1,
            sessionReady: 1,
            taskNotifications: 1,
            sessionCompletion: 1,
            updatedAt: 0
        })
    })
})

describe('PUT /api/notification-preferences', () => {
    it('updates only the provided fields and returns the merged result', async () => {
        const app = createApp()
        const res = await app.request('/api/notification-preferences', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionReady: 0 })
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
            namespace: 'test-ns',
            permissionRequests: 1,
            sessionReady: 0,
            taskNotifications: 1,
            sessionCompletion: 1
        })

        const getRes = await app.request('/api/notification-preferences')
        const body = await getRes.json() as { sessionReady: number }
        expect(body.sessionReady).toBe(0)
    })

    it('rejects out-of-range values', async () => {
        const app = createApp()
        const res = await app.request('/api/notification-preferences', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ permissionRequests: 2 })
        })
        expect(res.status).toBe(400)
    })

    it('rejects invalid bodies', async () => {
        const app = createApp()
        const res = await app.request('/api/notification-preferences', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionReady: 'yes' })
        })
        expect(res.status).toBe(400)
    })
})

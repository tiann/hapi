import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { Store } from '../../store'
import { createDevicesRoutes } from './devices'

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
    app.route('/api', createDevicesRoutes(store))
    return app
}

describe('devices routes', () => {
    it('registers and unregisters FCM devices for namespace', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        const register = await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'fcm-tok-1',
                platform: 'wear',
                deviceId: 'watch-1'
            })
        })
        expect(register.status).toBe(200)

        const devices = store.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].platform).toBe('wear')

        const unregister = await app.request('/api/devices/register', {
            method: 'DELETE',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'fcm-tok-1' })
        })
        expect(unregister.status).toBe(200)
        expect(store.fcm.getDevicesByNamespace('default')).toHaveLength(0)
    })
})

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

    it('phone/wear registration is unchanged: no pushKey required, extra pushKey ignored', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        const register = await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'fcm-tok-2',
                platform: 'phone',
                deviceId: 'pixel-1',
                pushKey: 'not-validated-for-android'
            })
        })
        expect(register.status).toBe(200)

        const devices = store.fcm.getDevicesByNamespace('default')
        expect(devices).toHaveLength(1)
        expect(devices[0].platform).toBe('phone')
        expect(devices[0].pushKey).toBeNull()
    })

    it('registers an iOS device with a valid 32-byte pushKey', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()
        const pushKey = Buffer.alloc(32, 9).toString('base64')

        const register = await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'a1b2c3d4e5f6',
                platform: 'ios',
                deviceId: 'iphone-1',
                pushKey
            })
        })
        expect(register.status).toBe(200)

        const devices = store.fcm.getDevicesByNamespace('default', ['ios'])
        expect(devices).toHaveLength(1)
        expect(devices[0].platform).toBe('ios')
        expect(devices[0].token).toBe('a1b2c3d4e5f6')
        expect(devices[0].pushKey).toBe(pushKey)
    })

    it('rejects iOS registration without a pushKey', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        const register = await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'a1b2c3',
                platform: 'ios',
                deviceId: 'iphone-1'
            })
        })
        expect(register.status).toBe(400)
        expect(store.fcm.getDevicesByNamespace('default')).toHaveLength(0)
    })

    it('rejects an iOS pushKey that is not exactly 32 bytes', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        for (const badKey of [
            Buffer.alloc(31, 1).toString('base64'),
            Buffer.alloc(33, 1).toString('base64'),
            'AAAA'
        ]) {
            const register = await app.request('/api/devices/register', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({
                    token: 'a1b2c3',
                    platform: 'ios',
                    deviceId: 'iphone-1',
                    pushKey: badKey
                })
            })
            expect(register.status).toBe(400)
        }
        expect(store.fcm.getDevicesByNamespace('default')).toHaveLength(0)
    })

    it('rejects an iOS pushKey with a non-base64 alphabet even at the right length', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        // 44 chars like a real 32-byte key, but with characters Buffer.from
        // would silently skip - must be rejected, not laundered.
        const garbage = '!'.repeat(2) + Buffer.alloc(32, 1).toString('base64').slice(2)
        const register = await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'a1b2c3',
                platform: 'ios',
                deviceId: 'iphone-1',
                pushKey: garbage
            })
        })
        expect(register.status).toBe(400)
    })

    it('unregisters an iOS device by token (DELETE unchanged)', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const headers = await authHeaders()

        await app.request('/api/devices/register', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
                token: 'apns-tok-1',
                platform: 'ios',
                deviceId: 'iphone-1',
                pushKey: Buffer.alloc(32, 5).toString('base64')
            })
        })
        expect(store.fcm.getDevicesByNamespace('default', ['ios'])).toHaveLength(1)

        const unregister = await app.request('/api/devices/register', {
            method: 'DELETE',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ token: 'apns-tok-1' })
        })
        expect(unregister.status).toBe(200)
        expect(store.fcm.getDevicesByNamespace('default', ['ios'])).toHaveLength(0)
    })
})

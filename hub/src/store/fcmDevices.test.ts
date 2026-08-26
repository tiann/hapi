import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('fcmDevices upsert', () => {
    it('moves a token to a new namespace and removes the old namespace row', () => {
        const store = new Store(':memory:')
        const device = { token: 'shared-token', platform: 'phone' as const, deviceId: 'pixel-1' }

        store.fcm.upsertDevice('namespace-a', device)
        store.fcm.upsertDevice('namespace-b', device)

        expect(store.fcm.getDevicesByNamespace('namespace-a')).toHaveLength(0)
        expect(store.fcm.getDevicesByNamespace('namespace-b')).toHaveLength(1)
        expect(store.fcm.getDevicesByNamespace('namespace-b')[0].token).toBe('shared-token')
    })

    it('stores ios rows with pushKey and rotates key + token on re-registration', () => {
        const store = new Store(':memory:')
        const keyA = Buffer.alloc(32, 1).toString('base64')
        const keyB = Buffer.alloc(32, 2).toString('base64')

        store.fcm.upsertDevice('default', { token: 'apns-1', platform: 'ios', deviceId: 'iphone-1', pushKey: keyA })
        let rows = store.fcm.getDevicesByNamespace('default', ['ios'])
        expect(rows).toHaveLength(1)
        expect(rows[0].pushKey).toBe(keyA)

        // Same install re-registers with a rotated APNs token and fresh key.
        store.fcm.upsertDevice('default', { token: 'apns-2', platform: 'ios', deviceId: 'iphone-1', pushKey: keyB })
        rows = store.fcm.getDevicesByNamespace('default', ['ios'])
        expect(rows).toHaveLength(1)
        expect(rows[0].token).toBe('apns-2')
        expect(rows[0].pushKey).toBe(keyB)
    })

    it('phone/wear rows keep a null pushKey', () => {
        const store = new Store(':memory:')
        store.fcm.upsertDevice('default', { token: 'fcm-1', platform: 'wear', deviceId: 'watch-1' })
        expect(store.fcm.getDevicesByNamespace('default')[0].pushKey).toBeNull()
    })

    it('platform filter separates the FCM pipeline from the iOS pipeline', () => {
        const store = new Store(':memory:')
        store.fcm.upsertDevice('default', { token: 'fcm-1', platform: 'phone', deviceId: 'pixel-1' })
        store.fcm.upsertDevice('default', { token: 'fcm-2', platform: 'wear', deviceId: 'watch-1' })
        store.fcm.upsertDevice('default', {
            token: 'apns-1',
            platform: 'ios',
            deviceId: 'iphone-1',
            pushKey: Buffer.alloc(32, 3).toString('base64')
        })

        const fcmRows = store.fcm.getDevicesByNamespace('default', ['phone', 'wear'])
        expect(fcmRows.map((row) => row.token).sort()).toEqual(['fcm-1', 'fcm-2'])

        const iosRows = store.fcm.getDevicesByNamespace('default', ['ios'])
        expect(iosRows.map((row) => row.token)).toEqual(['apns-1'])

        // Unfiltered call still returns everything (registry view).
        expect(store.fcm.getDevicesByNamespace('default')).toHaveLength(3)
    })

    it('same deviceId can hold one row per platform (phone + ios coexist)', () => {
        const store = new Store(':memory:')
        store.fcm.upsertDevice('default', { token: 'fcm-1', platform: 'phone', deviceId: 'dev-1' })
        store.fcm.upsertDevice('default', {
            token: 'apns-1',
            platform: 'ios',
            deviceId: 'dev-1',
            pushKey: Buffer.alloc(32, 4).toString('base64')
        })
        expect(store.fcm.getDevicesByNamespace('default')).toHaveLength(2)
    })
})

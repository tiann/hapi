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
})

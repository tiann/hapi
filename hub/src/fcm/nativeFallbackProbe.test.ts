import { describe, expect, it, mock } from 'bun:test'
import type { Store } from '../store'
import { buildNativeFallbackProbe } from './nativeFallbackProbe'

type FakeStore = {
    fcm: { getDevicesByNamespace: ReturnType<typeof mock> }
}

function makeStore(perNs: Record<string, number>): FakeStore {
    return {
        fcm: {
            getDevicesByNamespace: mock((ns: string) =>
                Array.from({ length: perNs[ns] ?? 0 }, (_, i) => ({
                    id: i,
                    namespace: ns,
                    token: `tok-${i}`,
                    platform: 'phone' as const,
                    deviceId: `dev-${i}`,
                    createdAt: 0,
                    updatedAt: 0
                }))
            )
        }
    }
}

describe('buildNativeFallbackProbe', () => {
    it('returns false for every namespace when FCM is not configured (regression for HAPI Bot finding)', () => {
        const store = makeStore({ default: 5, alt: 1 })
        const probe = buildNativeFallbackProbe(store as unknown as Store, null)

        expect(probe('default')).toBe(false)
        expect(probe('alt')).toBe(false)
        expect(probe('nonexistent')).toBe(false)
    })

    it('does not query the device store when FCM is not configured', () => {
        const store = makeStore({ default: 5 })
        const probe = buildNativeFallbackProbe(store as unknown as Store, null)

        probe('default')

        // If we hit the store, stale device rows would silently suppress
        // web-push for a hub running without FCM. The contract is that
        // the no-config branch never even consults the store.
        expect(store.fcm.getDevicesByNamespace).not.toHaveBeenCalled()
    })

    it('returns true only for namespaces with at least one registered device when FCM is configured', () => {
        const store = makeStore({ default: 2, empty: 0 })
        const fcmConfig = { projectId: 'p', serviceAccount: { client_email: 'x', private_key: 'y' } }
        const probe = buildNativeFallbackProbe(store as unknown as Store, fcmConfig)

        expect(probe('default')).toBe(true)
        expect(probe('empty')).toBe(false)
        expect(probe('untouched')).toBe(false)
    })

    it('returns false when fcmService reports unhealthy, even with registered devices', () => {
        const store = makeStore({ default: 3 })
        const fcmConfig = { projectId: 'p', serviceAccount: { client_email: 'x', private_key: 'y' } }
        const fcmService = { isHealthy: mock(() => false) }
        const probe = buildNativeFallbackProbe(store as unknown as Store, fcmConfig, fcmService)

        expect(probe('default')).toBe(false)
        expect(fcmService.isHealthy).toHaveBeenCalled()
        // We short-circuit before hitting the device store - the namespace
        // has registered devices but a broken FCM pipeline means web-push
        // is the only surface still able to reach the operator.
        expect(store.fcm.getDevicesByNamespace).not.toHaveBeenCalled()
    })

    it('returns true when fcmService reports healthy and devices exist', () => {
        const store = makeStore({ default: 1 })
        const fcmConfig = { projectId: 'p', serviceAccount: { client_email: 'x', private_key: 'y' } }
        const fcmService = { isHealthy: mock(() => true) }
        const probe = buildNativeFallbackProbe(store as unknown as Store, fcmConfig, fcmService)

        expect(probe('default')).toBe(true)
        expect(fcmService.isHealthy).toHaveBeenCalled()
    })

    it('treats absent fcmService as healthy (back-compat with single-arg call site)', () => {
        const store = makeStore({ default: 2 })
        const fcmConfig = { projectId: 'p', serviceAccount: { client_email: 'x', private_key: 'y' } }
        const probe = buildNativeFallbackProbe(store as unknown as Store, fcmConfig)

        expect(probe('default')).toBe(true)
    })
})

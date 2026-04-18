import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { usePushNotifications } from './usePushNotifications'

function installUnsupportedPushGlobals() {
    Reflect.deleteProperty(window.navigator, 'serviceWorker')
    Reflect.deleteProperty(window, 'PushManager')
    Reflect.deleteProperty(window, 'Notification')
}

function installSupportedPushGlobals(options?: { permission?: NotificationPermission }) {
    const permission = options?.permission ?? 'granted'
    const subscriptionJson = {
        endpoint: 'https://push.example/subscription',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
    }
    const subscription = {
        endpoint: subscriptionJson.endpoint,
        toJSON: () => subscriptionJson,
        unsubscribe: vi.fn(async () => true)
    }
    const pushManager = {
        getSubscription: vi.fn(async () => null),
        subscribe: vi.fn(async () => subscription)
    }
    const ready = Promise.resolve({ pushManager })

    Object.defineProperty(window.navigator, 'serviceWorker', {
        configurable: true,
        value: { ready }
    })
    Object.defineProperty(window, 'PushManager', {
        configurable: true,
        value: function PushManager() {}
    })
    Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: {
            permission,
            requestPermission: vi.fn(async () => permission)
        }
    })

    return { pushManager, subscription }
}

function createApi(): ApiClient & {
    subscribed: unknown[]
} {
    const subscribed: unknown[] = []
    return {
        subscribed,
        getPushVapidPublicKey: vi.fn(async () => ({ publicKey: 'AQAB' })),
        subscribePushNotifications: vi.fn(async (payload: unknown) => {
            subscribed.push(payload)
        }),
        unsubscribePushNotifications: vi.fn(async () => {})
    } as unknown as ApiClient & { subscribed: unknown[] }
}

describe('usePushNotifications', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        installUnsupportedPushGlobals()
    })

    it('reports unsupported browsers and exposes refreshSubscription', async () => {
        const { result } = renderHook(() => usePushNotifications(null))

        await waitFor(() => {
            expect(result.current.isSupported).toBe(false)
            expect(result.current.isSubscribed).toBe(false)
        })
        expect(typeof result.current.refreshSubscription).toBe('function')
    })

    it('subscribes and posts endpoint keys when permission is granted', async () => {
        const { pushManager } = installSupportedPushGlobals({ permission: 'granted' })
        const api = createApi()
        const { result } = renderHook(() => usePushNotifications(api))

        await act(async () => {
            const ok = await result.current.subscribe()
            expect(ok).toBe(true)
        })

        expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
        expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: 'https://push.example/subscription',
            keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
        })
        expect(result.current.isSubscribed).toBe(true)
    })
})

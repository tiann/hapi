import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { usePushNotifications } from '@/hooks/usePushNotifications'

const VAPID_STORAGE_KEY = 'hapi.push.vapidKey'
const CURRENT_VAPID_KEY = 'AQIDBA'

type PushSubscriptionMock = {
    endpoint: string
    unsubscribe: ReturnType<typeof vi.fn>
    toJSON: ReturnType<typeof vi.fn>
}

function createSubscription(endpoint: string, unsubscribeResult: boolean | Error): PushSubscriptionMock {
    return {
        endpoint,
        unsubscribe: unsubscribeResult instanceof Error
            ? vi.fn().mockRejectedValue(unsubscribeResult)
            : vi.fn().mockResolvedValue(unsubscribeResult),
        toJSON: vi.fn().mockReturnValue({
            endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' }
        })
    }
}

function setupPushEnvironment(existing: PushSubscriptionMock, replacement: PushSubscriptionMock) {
    const pushManager = {
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn().mockResolvedValue(replacement)
    }
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { ready: Promise.resolve({ pushManager }) }
    })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
    Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') }
    })
    return pushManager
}

function createApi() {
    return {
        getPushVapidPublicKey: vi.fn().mockResolvedValue({ publicKey: CURRENT_VAPID_KEY }),
        subscribePushNotifications: vi.fn().mockResolvedValue(undefined),
        unsubscribePushNotifications: vi.fn().mockResolvedValue(undefined)
    }
}

describe('usePushNotifications VAPID rotation', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem(VAPID_STORAGE_KEY, 'stale-key')
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('preserves the existing registration when browser unsubscribe returns false', async () => {
        const existing = createSubscription('https://push.test/stale', false)
        const replacement = createSubscription('https://push.test/current', true)
        const pushManager = setupPushEnvironment(existing, replacement)
        const api = createApi()
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient))

        await waitFor(() => expect(result.current.isSupported).toBe(true))

        let success = true
        await act(async () => {
            success = await result.current.subscribe()
        })

        expect(success).toBe(false)
        expect(api.unsubscribePushNotifications).not.toHaveBeenCalled()
        expect(pushManager.subscribe).not.toHaveBeenCalled()
        expect(api.subscribePushNotifications).not.toHaveBeenCalled()
        expect(localStorage.getItem(VAPID_STORAGE_KEY)).toBe('stale-key')
    })

    it('preserves the existing registration when browser unsubscribe rejects', async () => {
        const existing = createSubscription('https://push.test/stale', new Error('unsubscribe failed'))
        const replacement = createSubscription('https://push.test/current', true)
        const pushManager = setupPushEnvironment(existing, replacement)
        const api = createApi()
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient))

        await waitFor(() => expect(result.current.isSupported).toBe(true))

        let success = true
        await act(async () => {
            success = await result.current.subscribe()
        })

        expect(success).toBe(false)
        expect(consoleError).toHaveBeenCalled()
        expect(api.unsubscribePushNotifications).not.toHaveBeenCalled()
        expect(pushManager.subscribe).not.toHaveBeenCalled()
        expect(api.subscribePushNotifications).not.toHaveBeenCalled()
        expect(localStorage.getItem(VAPID_STORAGE_KEY)).toBe('stale-key')
    })

    it('replaces and registers the subscription after browser unsubscribe succeeds', async () => {
        const existing = createSubscription('https://push.test/stale', true)
        const replacement = createSubscription('https://push.test/current', true)
        const pushManager = setupPushEnvironment(existing, replacement)
        const api = createApi()
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient))

        await waitFor(() => expect(result.current.isSupported).toBe(true))

        let success = false
        await act(async () => {
            success = await result.current.subscribe()
        })

        expect(success).toBe(true)
        expect(api.unsubscribePushNotifications).toHaveBeenCalledWith({ endpoint: existing.endpoint })
        expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
        expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: replacement.endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' }
        })
        expect(localStorage.getItem(VAPID_STORAGE_KEY)).toBe(CURRENT_VAPID_KEY)
    })
})

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { pushNotificationsDisabled, usePushNotifications } from '@/hooks/usePushNotifications'

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

    it('persists an explicit unsubscribe so startup will not re-enable it', async () => {
        const existing = createSubscription('https://push.test/current', true)
        const manager = setupPushEnvironment(existing, existing)
        existing.unsubscribe.mockImplementation(async () => {
            manager.getSubscription.mockResolvedValue(null)
            return true
        })
        const api = createApi()
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient))
        await waitFor(() => expect(result.current.isSubscribed).toBe(true))
        await act(async () => { expect(await result.current.unsubscribe()).toBe(true) })
        expect(pushNotificationsDisabled()).toBe(true)
        expect(result.current.isSubscribed).toBe(false)
        expect(api.unsubscribePushNotifications).toHaveBeenCalledWith({ endpoint: existing.endpoint })
    })

    it('synchronizes settings with startup recovery and ignores an older refresh', async () => {
        const subscription = createSubscription('https://push.test/current', true)
        const manager = setupPushEnvironment(subscription, subscription)
        let current: PushSubscriptionMock | null = null
        let finishOldRefresh!: (value: null) => void
        const oldRefresh = new Promise<null>(resolve => { finishOldRefresh = resolve })
        manager.getSubscription
            .mockImplementationOnce(() => oldRefresh)
            .mockImplementation(async () => current)
        manager.subscribe.mockImplementation(async () => { current = subscription; return subscription })
        subscription.unsubscribe.mockImplementation(async () => { current = null; return true })
        const api = createApi() as unknown as ApiClient
        const settings = renderHook(() => usePushNotifications(api))
        const startup = renderHook(() => usePushNotifications(api))
        await waitFor(() => expect(startup.result.current.isSupported).toBe(true))

        await act(async () => { expect(await startup.result.current.subscribe()).toBe(true) })
        await waitFor(() => expect(settings.result.current.isSubscribed).toBe(true))
        await act(async () => { finishOldRefresh(null); await oldRefresh })
        expect(settings.result.current.isSubscribed).toBe(true)

        await act(async () => { expect(await settings.result.current.unsubscribe()).toBe(true) })
        await waitFor(() => expect(startup.result.current.isSubscribed).toBe(false))
    })

    it('keeps an explicit opt-out when an older startup registration finishes later', async () => {
        const subscription = createSubscription('https://push.test/current', true)
        const manager = setupPushEnvironment(subscription, subscription)
        let current: PushSubscriptionMock | null = subscription
        manager.getSubscription.mockImplementation(async () => current)
        subscription.unsubscribe.mockImplementation(async () => { current = null; return true })
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        let finishRegistration!: () => void
        const registration = new Promise<void>(resolve => { finishRegistration = resolve })
        const api = createApi()
        api.subscribePushNotifications.mockReturnValueOnce(registration)
        const startup = renderHook(() => usePushNotifications(api as unknown as ApiClient))
        const settings = renderHook(() => usePushNotifications(api as unknown as ApiClient))
        await waitFor(() => expect(settings.result.current.isSubscribed).toBe(true))

        let recovery!: Promise<boolean>
        act(() => { recovery = startup.result.current.subscribe() })
        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledOnce())
        await act(async () => { expect(await settings.result.current.unsubscribe()).toBe(true) })
        expect(pushNotificationsDisabled()).toBe(true)
        await act(async () => { finishRegistration(); expect(await recovery).toBe(false) })

        expect(pushNotificationsDisabled()).toBe(true)
        expect(settings.result.current.isSubscribed).toBe(false)
        // The late registration is removed even if the first delete won the race.
        expect(api.unsubscribePushNotifications).toHaveBeenCalledTimes(2)
    })

    it('registers a subsequent enable only after stale registration cleanup', async () => {
        const oldSubscription = createSubscription('https://push.test/old', true)
        const newSubscription = createSubscription('https://push.test/new', true)
        const manager = setupPushEnvironment(oldSubscription, newSubscription)
        let current: PushSubscriptionMock | null = oldSubscription
        manager.getSubscription.mockImplementation(async () => current)
        manager.subscribe.mockImplementation(async () => { current = newSubscription; return newSubscription })
        oldSubscription.unsubscribe.mockImplementation(async () => { current = null; return true })
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        let finishOld!: () => void
        const oldRequest = new Promise<void>(resolve => { finishOld = resolve })
        const api = createApi()
        api.subscribePushNotifications.mockReturnValueOnce(oldRequest)
        const startup = renderHook(() => usePushNotifications(api as unknown as ApiClient))
        const settings = renderHook(() => usePushNotifications(api as unknown as ApiClient))
        await waitFor(() => expect(settings.result.current.isSubscribed).toBe(true))
        let oldRecovery!: Promise<boolean>
        act(() => { oldRecovery = startup.result.current.subscribe() })
        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledOnce())
        await act(async () => { expect(await settings.result.current.unsubscribe()).toBe(true) })
        let enable!: Promise<boolean>
        act(() => { enable = settings.result.current.subscribe() })
        await act(async () => { finishOld(); expect(await oldRecovery).toBe(false); expect(await enable).toBe(true) })
        expect(api.subscribePushNotifications).toHaveBeenCalledTimes(2)
        expect(api.unsubscribePushNotifications).toHaveBeenLastCalledWith({ endpoint: oldSubscription.endpoint })
        expect(pushNotificationsDisabled()).toBe(false)
    })
})

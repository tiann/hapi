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
    // Model the browser: `getSubscription()` follows whatever the last
    // `subscribe()` returned, so post-write checks see the live subscription.
    let current: PushSubscriptionMock | null = existing
    const pushManager = {
        getSubscription: vi.fn(async () => current),
        subscribe: vi.fn(async () => {
            current = replacement
            return replacement
        })
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
            keys: { p256dh: 'p256dh', auth: 'auth' },
            // The hub stores this to render web-push payloads in the user's language.
            language: expect.any(String)
        })
        expect(localStorage.getItem(VAPID_STORAGE_KEY)).toBe(CURRENT_VAPID_KEY)
    })

    it('refreshes the hub language when the UI language changes', async () => {
        // A stored VAPID key matching the hub marks the browser subscription as
        // current, which is what gates the refresh.
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        const replacement = createSubscription('https://push.test/current', true)
        setupPushEnvironment(existing, replacement)
        const api = createApi()
        const { rerender } = renderHook(
            ({ language }: { language: string }) => usePushNotifications(api as unknown as ApiClient, language),
            { initialProps: { language: 'en' } }
        )

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: existing.endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' },
            language: 'en'
        }))

        localStorage.setItem('hapi-lang', 'ru')
        rerender({ language: 'ru' })

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: existing.endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' },
            language: 'ru'
        }))
    })

    it('retries a failed language refresh on the next change', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        setupPushEnvironment(existing, existing)
        const api = createApi()
        api.subscribePushNotifications
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(undefined)
        const { rerender } = renderHook(
            ({ language }: { language: string }) => usePushNotifications(api as unknown as ApiClient, language),
            { initialProps: { language: 'en' } }
        )

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledTimes(1))

        localStorage.setItem('hapi-lang', 'ru')
        rerender({ language: 'ru' })

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenLastCalledWith({
            endpoint: existing.endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' },
            language: 'ru'
        }))
    })

    it('undoes an in-flight language write after the browser subscription is removed', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        const pushManager = setupPushEnvironment(existing, existing)
        const api = createApi()
        let releaseWrite: () => void = () => {}
        api.subscribePushNotifications = vi.fn(() => new Promise<void>((resolve) => {
            releaseWrite = () => resolve()
        }))
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient, 'en'))

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledTimes(1))

        await act(async () => {
            await result.current.unsubscribe()
            pushManager.getSubscription.mockResolvedValue(null)
        })
        releaseWrite()

        // Once by `unsubscribe()` and once by the stale write cleanup.
        await waitFor(() => expect(api.unsubscribePushNotifications).toHaveBeenCalledTimes(2))
    })

    it('does not let an explicit subscribe overwrite a newer language', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        setupPushEnvironment(existing, existing)
        const api = createApi()
        const languages: Array<string | undefined> = []
        let releaseFirst: () => void = () => {}
        api.subscribePushNotifications = vi.fn((payload: { language?: string }) => {
            languages.push(payload.language)
            if (languages.length === 1) {
                return new Promise<void>((resolve) => {
                    releaseFirst = () => resolve()
                })
            }
            return Promise.resolve()
        })
        const { result, rerender } = renderHook(
            ({ language }: { language: string }) => usePushNotifications(api as unknown as ApiClient, language),
            { initialProps: { language: 'en' } }
        )

        await waitFor(() => expect(languages).toEqual(['en']))

        localStorage.setItem('hapi-lang', 'ru')
        rerender({ language: 'ru' })
        let subscribed = false
        const subscribePromise = act(async () => {
            subscribed = await result.current.subscribe()
        })
        releaseFirst()
        await subscribePromise

        expect(subscribed).toBe(true)
        expect(languages.at(-1)).toBe('ru')
    })

    it('prunes the endpoint it wrote when the browser switched subscriptions', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        const replacement = createSubscription('https://push.test/other', true)
        const pushManager = setupPushEnvironment(existing, replacement)
        const api = createApi()
        let releaseWrite: () => void = () => {}
        api.subscribePushNotifications = vi.fn(() => new Promise<void>((resolve) => {
            releaseWrite = () => resolve()
        }))
        renderHook(() => usePushNotifications(api as unknown as ApiClient, 'en'))

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledTimes(1))

        pushManager.getSubscription.mockResolvedValue(replacement)
        releaseWrite()

        await waitFor(() => expect(api.unsubscribePushNotifications).toHaveBeenCalledWith({
            endpoint: existing.endpoint
        }))
    })

    it('keeps a re-created subscription that reuses the same endpoint', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        const pushManager = setupPushEnvironment(existing, existing)
        const api = createApi()
        let releaseRefresh: () => void = () => {}
        api.subscribePushNotifications = vi.fn(() => new Promise<void>((resolve) => {
            releaseRefresh = () => resolve()
        }))
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient, 'en'))

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledTimes(1))

        await act(async () => {
            await result.current.unsubscribe()
            // The push service handed back the same endpoint for a fresh
            // subscription, so the stale refresh must not prune it.
            pushManager.getSubscription.mockResolvedValue(existing)
        })
        releaseRefresh()
        await Promise.resolve()

        expect(api.unsubscribePushNotifications).toHaveBeenCalledTimes(1)
    })

    it('keeps the hub registration when the browser refuses to unsubscribe', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', false)
        setupPushEnvironment(existing, existing)
        const api = createApi()
        let releaseRefresh: () => void = () => {}
        api.subscribePushNotifications = vi.fn(() => new Promise<void>((resolve) => {
            releaseRefresh = () => resolve()
        }))
        const { result } = renderHook(() => usePushNotifications(api as unknown as ApiClient, 'en'))

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledTimes(1))

        await act(async () => {
            await result.current.unsubscribe()
        })
        releaseRefresh()
        await Promise.resolve()

        // The browser still owns the subscription, so the refresh must survive.
        expect(api.unsubscribePushNotifications).not.toHaveBeenCalled()
    })

    it('applies only the latest language when refreshes overlap', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        localStorage.setItem('hapi-lang', 'en')
        const existing = createSubscription('https://push.test/current', true)
        setupPushEnvironment(existing, existing)
        const api = createApi()
        const calls: string[] = []
        let releaseFirst: () => void = () => {}
        api.subscribePushNotifications = vi.fn((payload: { language?: string }) => {
            calls.push(payload.language ?? '')
            if (calls.length === 1) {
                return new Promise<void>((resolve) => {
                    releaseFirst = () => resolve()
                })
            }
            return Promise.resolve()
        })
        const { rerender } = renderHook(
            ({ language }: { language: string }) => usePushNotifications(api as unknown as ApiClient, language),
            { initialProps: { language: 'en' } }
        )

        await waitFor(() => expect(calls).toEqual(['en']))

        localStorage.setItem('hapi-lang', 'ru')
        rerender({ language: 'ru' })
        releaseFirst()

        await waitFor(() => expect(calls).toEqual(['en', 'ru']))
    })

    it('registers the browser language when the web UI ships no matching locale', async () => {
        localStorage.setItem(VAPID_STORAGE_KEY, CURRENT_VAPID_KEY)
        const existing = createSubscription('https://push.test/current', true)
        const replacement = createSubscription('https://push.test/current', true)
        setupPushEnvironment(existing, replacement)
        const api = createApi()
        // The web UI falls back to `en` for an unsupported browser language;
        // the hub should still get the browser's own tag so its push text can
        // be localized.
        renderHook(() => usePushNotifications(api as unknown as ApiClient, 'en'))

        await waitFor(() => expect(api.subscribePushNotifications).toHaveBeenCalledWith({
            endpoint: existing.endpoint,
            keys: { p256dh: 'p256dh', auth: 'auth' },
            language: 'en-US'
        }))
    })
})

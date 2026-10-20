import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'

function isPushSupported(): boolean {
    return typeof window !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
    const base64 = (base64Url + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/')
    const raw = atob(base64)
    const output = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) {
        output[i] = raw.charCodeAt(i)
    }
    return output
}

/**
 * Language reported to the hub with the subscription so web-push payloads can
 * be rendered in the user's language: the language the user picked in the web
 * UI, else the browser's own tag (which may be one the web UI does not ship,
 * e.g. `ru-RU`), else the caller's fallback.
 */
function notificationLanguage(fallback?: string): string | undefined {
    try {
        const stored = localStorage.getItem('hapi-lang')
        if (stored) return stored
    } catch {
        // Storage can be unavailable (private mode / blocked cookies).
    }
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language
    return fallback
}

/**
 * VAPID public key that the currently stored push subscription was created
 * with. When the hub changes (or its keys rotate), existing browser
 * subscriptions become undeliverable (push services reject them with
 * VapidPkHashMismatch), so we compare and re-create them on the next load.
 */
const PUSH_VAPID_KEY_STORAGE = 'hapi.push.vapidKey'

function readStoredVapidKey(): string | null {
    try {
        return localStorage.getItem(PUSH_VAPID_KEY_STORAGE)
    } catch {
        return null
    }
}

function writeStoredVapidKey(publicKey: string): void {
    try {
        localStorage.setItem(PUSH_VAPID_KEY_STORAGE, publicKey)
    } catch {
        // Ignore storage errors — the key check degrades to a re-subscribe.
    }
}

export function usePushNotifications(api: ApiClient | null, language?: string) {
    const [isSupported, setIsSupported] = useState(false)
    const [permission, setPermission] = useState<NotificationPermission>('default')
    const [isSubscribed, setIsSubscribed] = useState(false)

    const refreshSubscription = useCallback(async () => {
        if (!isPushSupported()) {
            setIsSupported(false)
            setIsSubscribed(false)
            return
        }

        setIsSupported(true)
        setPermission(Notification.permission)

        if (Notification.permission !== 'granted') {
            setIsSubscribed(false)
            return
        }

        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        let keyMatches = true
        if (subscription && api) {
            try {
                const { publicKey } = await api.getPushVapidPublicKey()
                keyMatches = readStoredVapidKey() === publicKey
            } catch {
                // Key lookup failed — keep the existing subscription benefit of
                // the doubt rather than showing a false "off" state.
            }
        }
        setIsSubscribed(Boolean(subscription) && keyMatches)
    }, [api])

    useEffect(() => {
        void refreshSubscription()
    }, [refreshSubscription])

    const requestPermission = useCallback(async (): Promise<boolean> => {
        if (!isPushSupported()) {
            return false
        }

        const result = await Notification.requestPermission()
        setPermission(result)
        if (result !== 'granted') {
            setIsSubscribed(false)
        }
        return result === 'granted'
    }, [])

    const languageWrites = useRef<Promise<void>>(Promise.resolve())
    const latestLanguage = useRef<string | undefined>(undefined)

    /**
     * Hub writes for this subscription run on a serialized queue, so an older
     * language can never land after a newer one.
     */
    const enqueueWrite = useCallback(<T,>(write: () => Promise<T>): Promise<T> => {
        const run = languageWrites.current.then(write)
        languageWrites.current = run.then(() => undefined, () => undefined)
        return run
    }, [])

    /**
     * After a write, the hub must only keep an endpoint the browser still
     * holds: a replacement or unsubscription during the request would
     * otherwise leave the previous endpoint registered.
     */
    const pruneReplacedEndpoint = useCallback(async (
        registration: ServiceWorkerRegistration,
        endpoint: string
    ): Promise<boolean> => {
        const current = await registration.pushManager.getSubscription()
        if (!current || current.endpoint !== endpoint) {
            await api?.unsubscribePushNotifications({ endpoint })
            return false
        }
        return true
    }, [api])

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        if (Notification.permission !== 'granted') {
            setPermission(Notification.permission)
            return false
        }

        try {
            const registration = await navigator.serviceWorker.ready
            const existing = await registration.pushManager.getSubscription()
            const { publicKey } = await api.getPushVapidPublicKey()
            const applicationServerKey = base64UrlToUint8Array(publicKey).buffer as ArrayBuffer
            // A subscription created against a previous hub or VAPID key can
            // never receive notifications from the current hub. Detect the
            // mismatch via the key recorded at subscribe time and recreate it.
            let subscription = existing
            if (existing && readStoredVapidKey() !== publicKey) {
                const staleEndpoint = existing.endpoint
                const unsubscribed = await existing.unsubscribe()
                if (!unsubscribed) return false
                // Prune the obsolete endpoint from the hub so it stops
                // receiving failed sends (VapidPkHashMismatch) for a
                // subscription that can no longer be reached.
                if (staleEndpoint) {
                    try {
                        await api.unsubscribePushNotifications({ endpoint: staleEndpoint })
                    } catch {
                        // Best-effort cleanup — a stale hub registration is
                        // harmless beyond repeated failed sends until pruned.
                    }
                }
                subscription = null
            }
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey
                })
            }

            const json = subscription.toJSON()
            const keys = json.keys
            if (!json.endpoint || !keys?.p256dh || !keys.auth) {
                return false
            }

            const endpoint = json.endpoint
            const pushKeys = { p256dh: keys.p256dh, auth: keys.auth }
            const registered = await enqueueWrite(async () => {
                await api.subscribePushNotifications({
                    endpoint,
                    keys: pushKeys,
                    // Resolved inside the queue so a newer language wins even
                    // when this call started earlier.
                    language: latestLanguage.current ?? notificationLanguage(language)
                })
                return await pruneReplacedEndpoint(registration, endpoint)
            })
            if (!registered) {
                return false
            }
            // Only record the key after the hub registration succeeded. A
            // failed registration must leave the previous key in place so the
            // next load retries the replacement instead of reusing a
            // subscription the hub never learned about.
            writeStoredVapidKey(publicKey)
            setIsSubscribed(true)
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to subscribe:', error)
            return false
        }
    }, [api, language, enqueueWrite, pruneReplacedEndpoint])

    const lastSentLanguage = useRef<string | undefined>(undefined)

    /**
     * Writes the subscription's language to the hub on a serialized queue, so
     * overlapping switches cannot land out of order. After the write it checks
     * that the browser still holds the subscription: an `unsubscribe()` during
     * the request would otherwise leave the hub with a dead endpoint.
     */
    const writeSubscriptionLanguage = useCallback((nextLanguage: string): Promise<boolean> => {
        latestLanguage.current = nextLanguage
        return enqueueWrite(async () => {
            // A newer switch queued behind this one already owns the write.
            if (latestLanguage.current !== nextLanguage) return false
            if (!api || !isPushSupported()) return false
            if (Notification.permission !== 'granted') return false

            try {
                const registration = await navigator.serviceWorker.ready
                const subscription = await registration.pushManager.getSubscription()
                if (!subscription) return false

                const json = subscription.toJSON()
                const keys = json.keys
                if (!json.endpoint || !keys?.p256dh || !keys.auth) return false

                const endpoint = json.endpoint
                await api.subscribePushNotifications({
                    endpoint,
                    keys: { p256dh: keys.p256dh, auth: keys.auth },
                    language: nextLanguage
                })

                return await pruneReplacedEndpoint(registration, endpoint)
            } catch (error) {
                console.error('[PushNotifications] Failed to refresh subscription language:', error)
                return false
            }
        })
    }, [api, enqueueWrite, pruneReplacedEndpoint])

    useEffect(() => {
        if (!isSubscribed) return

        const next = notificationLanguage(language)
        if (!next || next === lastSentLanguage.current) return
        void writeSubscriptionLanguage(next).then((sent) => {
            // Recorded only after the hub accepted the write, so a failure
            // retries on the next change instead of being suppressed.
            if (sent) lastSentLanguage.current = next
        })
    }, [isSubscribed, language, writeSubscriptionLanguage])

    const unsubscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) {
                setIsSubscribed(false)
                return true
            }

            const endpoint = subscription.endpoint
            const success = await subscription.unsubscribe()
            if (!success) return false
            await api.unsubscribePushNotifications({ endpoint })
            setIsSubscribed(false)
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to unsubscribe:', error)
            return false
        }
    }, [api])

    return {
        isSupported,
        permission,
        isSubscribed,
        requestPermission,
        subscribe,
        unsubscribe
    }
}

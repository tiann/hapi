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
 * VAPID public key that the currently stored push subscription was created
 * with. When the hub changes (or its keys rotate), existing browser
 * subscriptions become undeliverable (push services reject them with
 * VapidPkHashMismatch), so we compare and re-create them on the next load.
 */
const PUSH_VAPID_KEY_STORAGE = 'hapi.push.vapidKey'
const PUSH_DISABLED_STORAGE = 'hapi.push.disabled'
const PUSH_SUBSCRIPTION_CHANGED = 'hapi.push.subscriptionChanged'

// Subscription hooks are mounted independently in the app and settings.
// A later unsubscribe invalidates an earlier recovery, even while the hub
// request is in flight. Registrations are ordered so a stale registration's
// cleanup cannot remove a newer registration for the same endpoint.
let unsubscribeVersion = 0
let registrationTail: Promise<void> = Promise.resolve()

function queueRegistration<T>(work: () => Promise<T>): Promise<T> {
    const result = registrationTail.then(work)
    registrationTail = result.then(() => {}, () => {})
    return result
}

function notifySubscriptionChanged(): void {
    window.dispatchEvent(new Event(PUSH_SUBSCRIPTION_CHANGED))
}

export function pushNotificationsDisabled(): boolean {
    try { return localStorage.getItem(PUSH_DISABLED_STORAGE) === 'true' } catch { return false }
}

function setPushNotificationsDisabled(disabled: boolean): void {
    try {
        if (disabled) localStorage.setItem(PUSH_DISABLED_STORAGE, 'true')
        else localStorage.removeItem(PUSH_DISABLED_STORAGE)
    } catch { /* Browser subscription remains the source of truth. */ }
}

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

export function usePushNotifications(api: ApiClient | null) {
    const [isSupported, setIsSupported] = useState(false)
    const [permission, setPermission] = useState<NotificationPermission>('default')
    const [isSubscribed, setIsSubscribed] = useState(false)
    const refreshVersion = useRef(0)

    const refreshSubscription = useCallback(async () => {
        const version = ++refreshVersion.current
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
        if (version === refreshVersion.current) {
            setIsSubscribed(Boolean(subscription) && keyMatches)
        }
    }, [api])

    useEffect(() => {
        const onChange = () => { void refreshSubscription() }
        window.addEventListener(PUSH_SUBSCRIPTION_CHANGED, onChange)
        void refreshSubscription()
        return () => {
            window.removeEventListener(PUSH_SUBSCRIPTION_CHANGED, onChange)
            refreshVersion.current += 1
        }
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

    const subscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        if (Notification.permission !== 'granted') {
            setPermission(Notification.permission)
            return false
        }

        const version = unsubscribeVersion
        try {
            const registration = await navigator.serviceWorker.ready
            const existing = await registration.pushManager.getSubscription()
            const { publicKey } = await api.getPushVapidPublicKey()
            if (version !== unsubscribeVersion) return false
            const applicationServerKey = base64UrlToUint8Array(publicKey).buffer as ArrayBuffer
            // A subscription created against a previous hub or VAPID key can
            // never receive notifications from the current hub. Detect the
            // mismatch via the key recorded at subscribe time and recreate it.
            let subscription = existing
            if (existing && readStoredVapidKey() !== publicKey) {
                const staleEndpoint = existing.endpoint
                const unsubscribed = await existing.unsubscribe()
                if (!unsubscribed) return false
                if (version !== unsubscribeVersion) return false
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
                if (version !== unsubscribeVersion) {
                    // A disable may have run before the browser finished
                    // creating this subscription.
                    if (pushNotificationsDisabled()) await subscription.unsubscribe()
                    return false
                }
            }

            const json = subscription.toJSON()
            const keys = json.keys
            if (!json.endpoint || !keys?.p256dh || !keys.auth) {
                return false
            }
            const endpoint = json.endpoint
            const { p256dh, auth } = keys

            return await queueRegistration(async () => {
                if (version !== unsubscribeVersion) return false
                await api.subscribePushNotifications({
                    endpoint,
                    keys: { p256dh, auth }
                })
                if (version !== unsubscribeVersion) {
                    // The delete may have reached the hub before this older
                    // registration. Remove it again before newer registrations.
                    if (pushNotificationsDisabled()) {
                        await api.unsubscribePushNotifications({ endpoint })
                    }
                    return false
                }
                // Persist the key only after the hub registration succeeds.
                writeStoredVapidKey(publicKey)
                setPushNotificationsDisabled(false)
                setIsSubscribed(true)
                return true
            })
        } catch (error) {
            console.error('[PushNotifications] Failed to subscribe:', error)
            return false
        } finally {
            notifySubscriptionChanged()
        }
    }, [api])

    const unsubscribe = useCallback(async (): Promise<boolean> => {
        if (!api || !isPushSupported()) {
            return false
        }

        unsubscribeVersion += 1
        try {
            const registration = await navigator.serviceWorker.ready
            const subscription = await registration.pushManager.getSubscription()
            if (!subscription) {
                setPushNotificationsDisabled(true)
                setIsSubscribed(false)
                return true
            }

            const endpoint = subscription.endpoint
            const success = await subscription.unsubscribe()
            if (!success) return false
            setPushNotificationsDisabled(true)
            setIsSubscribed(false)
            await api.unsubscribePushNotifications({ endpoint })
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to unsubscribe:', error)
            return false
        } finally {
            notifySubscriptionChanged()
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

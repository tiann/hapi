import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'

function isPushSupported(): boolean {
    if (typeof window === 'undefined') {
        return false
    }

    const hasServiceWorker = 'serviceWorker' in navigator
    const hasPushManager = 'PushManager' in window
    const hasNotification = 'Notification' in window

    // Debug logging for iOS troubleshooting
    console.log('[PushNotifications] Support check:', {
        hasServiceWorker,
        hasPushManager,
        hasNotification,
        standalone: (window.navigator as Navigator & { standalone?: boolean }).standalone,
        displayMode: window.matchMedia('(display-mode: standalone)').matches
    })

    return hasServiceWorker && hasPushManager && hasNotification
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

export function usePushNotifications(api: ApiClient | null) {
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
        setIsSubscribed(Boolean(subscription))
    }, [])

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
            const subscription = existing ?? await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey
            })

            const json = subscription.toJSON()
            const keys = json.keys
            if (!json.endpoint || !keys?.p256dh || !keys.auth) {
                return false
            }

            await api.subscribePushNotifications({
                endpoint: json.endpoint,
                keys: {
                    p256dh: keys.p256dh,
                    auth: keys.auth
                }
            })
            setIsSubscribed(true)
            return true
        } catch (error) {
            console.error('[PushNotifications] Failed to subscribe:', error)
            return false
        }
    }, [api])

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
            await api.unsubscribePushNotifications({ endpoint })
            setIsSubscribed(false)
            return success
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

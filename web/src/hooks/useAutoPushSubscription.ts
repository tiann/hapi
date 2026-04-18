import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'

export type AutoPushSubscriptionOptions = {
    api: ApiClient | null
    token: string | null
    isTelegram: boolean
    isSupported: boolean
    permission: NotificationPermission
    subscribe: () => Promise<boolean>
}

export function useAutoPushSubscription(options: AutoPushSubscriptionOptions): void {
    const attemptedRef = useRef(false)

    useEffect(() => {
        if (!options.api || !options.token) {
            attemptedRef.current = false
            return
        }
        if (options.isTelegram || !options.isSupported || options.permission !== 'granted') {
            return
        }
        if (attemptedRef.current) {
            return
        }
        attemptedRef.current = true

        void options.subscribe()
    }, [
        options.api,
        options.isSupported,
        options.isTelegram,
        options.permission,
        options.subscribe,
        options.token
    ])
}

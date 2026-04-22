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

type AutoPushAttemptContext = {
    api: ApiClient
    token: string
}

function isSameAuthContext(
    a: AutoPushAttemptContext | null,
    b: AutoPushAttemptContext
): boolean {
    return a !== null && a.api === b.api && a.token === b.token
}

export function useAutoPushSubscription(options: AutoPushSubscriptionOptions): void {
    const attemptedContextRef = useRef<AutoPushAttemptContext | null>(null)

    useEffect(() => {
        if (!options.api || !options.token) {
            attemptedContextRef.current = null
            return
        }

        if (options.isTelegram || !options.isSupported || options.permission !== 'granted') {
            return
        }

        const authContext: AutoPushAttemptContext = {
            api: options.api,
            token: options.token
        }

        if (isSameAuthContext(attemptedContextRef.current, authContext)) {
            return
        }

        attemptedContextRef.current = authContext

        void options.subscribe()
            .then((success) => {
                if (!success && isSameAuthContext(attemptedContextRef.current, authContext)) {
                    attemptedContextRef.current = null
                }
            })
            .catch(() => {
                if (isSameAuthContext(attemptedContextRef.current, authContext)) {
                    attemptedContextRef.current = null
                }
            })
    }, [
        options.api,
        options.isSupported,
        options.isTelegram,
        options.permission,
        options.subscribe,
        options.token
    ])
}

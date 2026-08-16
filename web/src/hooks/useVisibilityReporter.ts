import { useEffect, useRef } from 'react'
import type { ApiClient } from '@/api/client'

type VisibilityState = 'visible' | 'hidden'

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

export function useVisibilityReporter(options: {
    api: ApiClient | null
    subscriptionId: string | null
    enabled?: boolean
}): void {
    const lastStateRef = useRef<VisibilityState | null>(null)
    const lastSubscriptionRef = useRef<string | null>(null)
    const pendingStateRef = useRef<VisibilityState | null>(null)
    const inFlightRef = useRef(false)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const clearRetry = () => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current)
            retryTimerRef.current = null
        }
    }

    useEffect(() => {
        if (options.enabled === false) {
            clearRetry()
            return
        }
        if (!options.api || !options.subscriptionId) {
            lastStateRef.current = null
            lastSubscriptionRef.current = options.subscriptionId ?? null
            pendingStateRef.current = null
            clearRetry()
            return
        }

        const api = options.api
        const subscriptionId = options.subscriptionId
        if (lastSubscriptionRef.current !== subscriptionId) {
            lastSubscriptionRef.current = subscriptionId
            lastStateRef.current = null
            pendingStateRef.current = null
            clearRetry()
        }

        const flush = () => {
            if (lastSubscriptionRef.current !== subscriptionId) {
                return
            }
            const desired = pendingStateRef.current
            if (!desired) {
                return
            }
            if (inFlightRef.current) {
                return
            }
            if (retryTimerRef.current) {
                return
            }
            if (lastStateRef.current === desired) {
                pendingStateRef.current = null
                return
            }

            inFlightRef.current = true
            let hadError = false
            const activeSubscription = subscriptionId
            void api.setVisibility({
                subscriptionId,
                visibility: desired
            }).then(() => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                lastStateRef.current = desired
                if (pendingStateRef.current === desired) {
                    pendingStateRef.current = null
                }
                clearRetry()
            }).catch((error) => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                hadError = true
                console.error('Failed to update visibility:', error)
                if (!retryTimerRef.current) {
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        flush()
                    }, 2000)
                }
            }).finally(() => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                inFlightRef.current = false
                if (hadError || retryTimerRef.current) {
                    return
                }
                if (pendingStateRef.current && pendingStateRef.current !== lastStateRef.current) {
                    flush()
                }
            })
        }

        const report = () => {
            const state = getVisibilityState()
            pendingStateRef.current = state
            flush()
        }

        report()
        document.addEventListener('visibilitychange', report)
        return () => {
            document.removeEventListener('visibilitychange', report)
            clearRetry()
            inFlightRef.current = false
        }
    }, [options.api, options.enabled, options.subscriptionId])
}

import { useEffect, useRef } from 'react'
import { ApiError, type ApiClient } from '@/api/client'

type VisibilityState = 'visible' | 'hidden'

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

// Transient failures (network errors, 5xx) retry with exponential backoff,
// bounded so a dead connection cannot retry forever.
const RETRY_BASE_DELAY_MS = 2000
const MAX_TRANSIENT_RETRIES = 5

function retryDelayMs(retryCount: number): number {
    return RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1)
}

/**
 * Whether an error is a permanent rejection for this subscription. A 4xx
 * (notably 404 when the hub no longer knows the subscription id) will fail
 * the same way on every retry; reporting resumes naturally once the SSE
 * connection is re-established with a fresh subscription id.
 */
function isPermanentRejection(error: unknown): boolean {
    return error instanceof ApiError && error.status >= 400 && error.status < 500
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
    const retryCountRef = useRef(0)
    const subscriptionAbandonedRef = useRef(false)

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
            retryCountRef.current = 0
            subscriptionAbandonedRef.current = false
            clearRetry()
        }

        const flush = () => {
            if (lastSubscriptionRef.current !== subscriptionId) {
                return
            }
            // A 4xx rejection is terminal for this subscription id; keep the
            // reporter silent until a new subscription id arrives.
            if (subscriptionAbandonedRef.current) {
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
                retryCountRef.current = 0
                if (pendingStateRef.current === desired) {
                    pendingStateRef.current = null
                }
                clearRetry()
            }).catch((error) => {
                if (lastSubscriptionRef.current !== activeSubscription) {
                    return
                }
                hadError = true
                if (isPermanentRejection(error)) {
                    // Terminal: stop reporting for this subscription id. The
                    // SSE reconnect issues a new id and reporting resumes.
                    subscriptionAbandonedRef.current = true
                    pendingStateRef.current = null
                    retryCountRef.current = 0
                    console.error(
                        `Visibility reporting rejected permanently for subscription ${activeSubscription}:`,
                        error
                    )
                    return
                }
                const retryCount = retryCountRef.current + 1
                if (retryCount > MAX_TRANSIENT_RETRIES) {
                    // Transient budget exhausted: abandon this report. The
                    // next visibility transition starts a fresh budget.
                    console.error('Failed to update visibility; giving up after retries:', error)
                    pendingStateRef.current = null
                    retryCountRef.current = 0
                    return
                }
                retryCountRef.current = retryCount
                console.error(`Failed to update visibility (retry ${retryCount}/${MAX_TRANSIENT_RETRIES}):`, error)
                if (!retryTimerRef.current) {
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        flush()
                    }, retryDelayMs(retryCount))
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
            if (pendingStateRef.current === null) {
                // A new delivery cycle gets a fresh transient-retry budget.
                retryCountRef.current = 0
            }
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

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * EventSource reports an error the moment a connection drops, including while
 * it is already retrying on its own - `readyState` is still CONNECTING and the
 * stream is usually back within a few seconds. Showing the banner immediately
 * turns those self-healing blips into a full-width "connection lost" warning,
 * which reads as a broken network even though nothing was lost.
 *
 * Waiting out a short grace period keeps genuine outages visible (the banner
 * still appears, just a moment later) while silent recoveries stay silent.
 * The sibling syncing banner debounces the same way in `useSyncingState`.
 */
export const RECONNECTING_BANNER_DELAY_MS = 4_000

export function useReconnectingState(): {
    isReconnecting: boolean
    reason: string | null
    reportConnect: () => void
    reportDisconnect: (reason: string) => void
} {
    const [isReconnecting, setIsReconnecting] = useState(false)
    const [reason, setReason] = useState<string | null>(null)
    const delayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const clearPending = useCallback(() => {
        if (delayTimeoutRef.current) {
            clearTimeout(delayTimeoutRef.current)
            delayTimeoutRef.current = null
        }
    }, [])

    const reportConnect = useCallback(() => {
        clearPending()
        setIsReconnecting(false)
        setReason(null)
    }, [clearPending])

    const reportDisconnect = useCallback((nextReason: string) => {
        // A reconnect attempt can fail repeatedly; keep the grace period
        // anchored to the first drop so the banner is not pushed back forever,
        // and keep the reason that started the outage.
        if (delayTimeoutRef.current) {
            return
        }
        delayTimeoutRef.current = setTimeout(() => {
            delayTimeoutRef.current = null
            setIsReconnecting(true)
            setReason(nextReason)
        }, RECONNECTING_BANNER_DELAY_MS)
    }, [])

    useEffect(() => {
        return clearPending
    }, [clearPending])

    return { isReconnecting, reason, reportConnect, reportDisconnect }
}

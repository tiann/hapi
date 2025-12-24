import { useCallback, useEffect, useRef, useState } from 'react'

let lastHiddenTimestamp: number | null = null

const MAX_SYNC_DURATION_MS = 10_000 // Auto-clear after 10 seconds
const BACKGROUND_THRESHOLD_MS = 30_000 // Consider "returning from background" if hidden within 30s
const DEBOUNCE_MS = 300 // Only show banner if sync takes longer than this

export function useSyncingState() {
    const [isSyncing, setIsSyncing] = useState(false)
    const startDelayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const maxDurationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                lastHiddenTimestamp = Date.now()
            }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
    }, [])

    const clearAllTimeouts = useCallback(() => {
        if (startDelayTimeoutRef.current) {
            clearTimeout(startDelayTimeoutRef.current)
            startDelayTimeoutRef.current = null
        }
        if (maxDurationTimeoutRef.current) {
            clearTimeout(maxDurationTimeoutRef.current)
            maxDurationTimeoutRef.current = null
        }
    }, [])

    const doStartSync = useCallback(() => {
        clearAllTimeouts()
        // Debounce: only show banner if sync takes longer than DEBOUNCE_MS
        startDelayTimeoutRef.current = setTimeout(() => {
            setIsSyncing(true)
            // Safety timeout: auto-clear after max duration to prevent stuck spinner
            maxDurationTimeoutRef.current = setTimeout(() => {
                setIsSyncing(false)
            }, MAX_SYNC_DURATION_MS)
        }, DEBOUNCE_MS)
    }, [clearAllTimeouts])

    const startSync = useCallback((options?: { force?: boolean }) => {
        if (options?.force) {
            doStartSync()
            return
        }
        // Only show syncing state when returning from background
        if (lastHiddenTimestamp && Date.now() - lastHiddenTimestamp < BACKGROUND_THRESHOLD_MS) {
            doStartSync()
        }
    }, [doStartSync])

    const endSync = useCallback(() => {
        // Clear all timeouts - if still in debounce period, banner never shows
        clearAllTimeouts()
        setIsSyncing(false)
    }, [clearAllTimeouts])

    useEffect(() => {
        return () => {
            clearAllTimeouts()
        }
    }, [clearAllTimeouts])

    return { isSyncing, startSync, endSync }
}

import { useEffect, useState } from 'react'

/**
 * True only once `value` has stayed true for `delayMs`; false immediately.
 * Transient connection states use it so a quick reconnect (tab refocus,
 * network handoff) never flashes a banner.
 */
export function useDelayedFlag(value: boolean, delayMs: number): boolean {
    const [revealed, setRevealed] = useState(false)

    useEffect(() => {
        if (!value) {
            setRevealed(false)
            return
        }
        const timer = setTimeout(() => setRevealed(true), delayMs)
        return () => clearTimeout(timer)
    }, [value, delayMs])

    return value && revealed
}

import { useEffect, useState } from 'react'

// Returns true only after `value` has been continuously true for `delayMs`;
// returns false again immediately when `value` turns false. Used to keep
// short-lived transient states (e.g. a 1-2s SSE reconnect) from flashing
// alarming UI.
export function useDelayedTrue(value: boolean, delayMs: number): boolean {
    const [delayed, setDelayed] = useState(false)

    useEffect(() => {
        if (!value) {
            setDelayed(false)
            return
        }
        const timer = setTimeout(() => setDelayed(true), delayMs)
        return () => clearTimeout(timer)
    }, [value, delayMs])

    return delayed
}

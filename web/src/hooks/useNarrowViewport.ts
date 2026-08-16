import { useEffect, useState } from 'react'

const NARROW_VIEWPORT_QUERY = '(max-width: 640px)'

/**
 * True when the viewport is narrow enough that the composer should collapse
 * value buttons (model / effort) into the settings sheet. SSR-safe: reports
 * the real match on first render on the client so a narrow first paint never
 * flashes controls the layout will hide.
 */
export function useNarrowViewport(): boolean {
    const [isNarrow, setIsNarrow] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(NARROW_VIEWPORT_QUERY).matches
    ))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return
        }
        const mql = window.matchMedia(NARROW_VIEWPORT_QUERY)
        const update = () => setIsNarrow(mql.matches)
        update()
        mql.addEventListener('change', update)
        return () => mql.removeEventListener('change', update)
    }, [])

    return isNarrow
}

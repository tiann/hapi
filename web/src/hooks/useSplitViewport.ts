import { useEffect, useState } from 'react'

// Mirrors tailwind.config.ts's `split` screen (920px) — the breakpoint where
// the sessions layout switches from a single pane to the two-pane split
// view. No shared constant exists between the Tailwind config and runtime JS,
// so this literal must stay in sync with that config by hand.
const SPLIT_VIEWPORT_QUERY = '(min-width: 920px)'

/**
 * True when the viewport is wide enough that the sessions layout renders
 * both panes at once (Tailwind's `split:` breakpoint). Needed outside CSS
 * when a decision (e.g. "is this pane actually visible to the user right
 * now") can't be expressed with Tailwind's `hidden split:flex` classes alone.
 */
export function useSplitViewport(): boolean {
    const [isSplit, setIsSplit] = useState(() => (
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia(SPLIT_VIEWPORT_QUERY).matches
    ))

    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return
        }
        const mql = window.matchMedia(SPLIT_VIEWPORT_QUERY)
        const update = () => setIsSplit(mql.matches)
        update()
        mql.addEventListener('change', update)
        return () => mql.removeEventListener('change', update)
    }, [])

    return isSplit
}

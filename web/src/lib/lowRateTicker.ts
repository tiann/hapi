/**
 * One shared low-rate ticker for the session list's idle activity indicators.
 *
 * Any *running* CSS animation makes the browser produce frames at 60 Hz for the
 * whole (large) list, so the per-frame cost is fixed no matter how small the
 * animated paint is. Driving the same motion from a single 8 Hz interval —
 * one tick for every indicator on the page — keeps the motion visible while
 * cutting the frame rate (and therefore the style recalc cost) by ~7x.
 *
 * The ticker is intentionally frame-based, not wall-clock based: subscribers
 * advance by a fixed step per tick, so the animation stays deterministic under
 * fake timers and never jumps after a hidden-tab resume.
 */

/** 8 Hz — the shared cadence for every idle indicator in the list. */
export const LOW_RATE_TICK_MS = 125

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export type LowRateTickListener = (frame: number) => void

export type LowRateTickerStatus = 'idle' | 'running' | 'paused' | 'reduced-motion'

type TimerHandle = ReturnType<typeof setInterval>

const listeners = new Set<LowRateTickListener>()
let timer: TimerHandle | null = null
let frame = 0
let visibilityBound = false
/**
 * The one list this ticker subscribed to, held for as long as it has
 * subscribers. `matchMedia` returns a distinct object per call, so the object
 * we attached the `change` listener to is the only one that can notify us:
 * re-reading `window.matchMedia(...)` and comparing identities would replace
 * our list with an unbound one and silently drop the preference updates
 * (reduced motion turning on or off while the page stays open).
 */
let mediaQuery: MediaQueryList | null = null
let mediaQueryBound = false

function getReducedMotionQuery(): MediaQueryList | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return null
    }
    if (!mediaQuery) {
        mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
    }
    return mediaQuery
}

function prefersReducedMotion(): boolean {
    // Read `matches` live: the cached list reflects the current preference.
    return mediaQuery?.matches === true
}

function documentIsHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden === true
}

function startTimer(): void {
    if (timer !== null) return
    timer = setInterval(tick, LOW_RATE_TICK_MS)
}

function stopTimer(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
}

function tick(): void {
    frame += 1
    // Copy first: a listener may unsubscribe while we are iterating.
    const current = Array.from(listeners)
    for (const listener of current) {
        listener(frame)
    }
}

function onVisibilityChange(): void {
    sync()
}

function onReducedMotionChange(): void {
    sync()
}

function bindVisibility(): void {
    if (visibilityBound || typeof document === 'undefined') return
    document.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
}

function unbindVisibility(): void {
    if (!visibilityBound || typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
}

function unbindListener(query: MediaQueryList): void {
    // Safari < 14 only implements the legacy listener API.
    if (typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', onReducedMotionChange)
    } else if (typeof query.removeListener === 'function') {
        query.removeListener(onReducedMotionChange)
    }
}

function bindReducedMotion(): void {
    const query = getReducedMotionQuery()
    if (mediaQueryBound || !query) return
    if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', onReducedMotionChange)
    } else if (typeof query.addListener === 'function') {
        query.addListener(onReducedMotionChange)
    }
    mediaQueryBound = true
}

function unbindReducedMotion(): void {
    if (!mediaQueryBound || !mediaQuery) return
    unbindListener(mediaQuery)
    mediaQueryBound = false
}

/**
 * Release everything the stopped ticker held. Dropping the cached list makes
 * the next subscriber bind a fresh one — the old object may belong to a
 * previous `window`, and its listeners must not outlive the subscription.
 */
function releaseReducedMotion(): void {
    unbindReducedMotion()
    mediaQuery = null
}

function sync(): void {
    if (listeners.size === 0) {
        stopTimer()
        unbindVisibility()
        releaseReducedMotion()
        return
    }
    if (prefersReducedMotion() || documentIsHidden()) {
        stopTimer()
        return
    }
    startTimer()
}

/** Current number of subscribers. Exposed for tests and diagnostics. */
export function lowRateTickerSubscriberCount(): number {
    return listeners.size
}

/** Whether the shared interval is currently running. */
export function lowRateTickerIsRunning(): boolean {
    return timer !== null
}

/** Latest frame counter handed to subscribers. Resets when the ticker drains. */
export function lowRateTickerFrame(): number {
    return frame
}

/** Why the ticker currently is (not) firing. Exposed for tests. */
export function lowRateTickerStatus(): LowRateTickerStatus {
    if (listeners.size === 0) return 'idle'
    if (prefersReducedMotion()) return 'reduced-motion'
    if (documentIsHidden()) return 'paused'
    return 'running'
}

/**
 * Subscribe to the shared ticker. The first subscriber starts the interval and
 * the last one clears it, so an idle page runs no timer at all.
 */
export function subscribeLowRateTicker(listener: LowRateTickListener): () => void {
    // The counter is shared, so a fresh subscriber must not inherit the phase
    // of a finished interval: without this, an indicator's first tick would
    // depend on how many ticks subscribers before it happened to consume, and
    // every indicator in a list would start on the same frame.
    if (listeners.size === 0) {
        frame = 0
    }
    listeners.add(listener)
    bindVisibility()
    bindReducedMotion()
    sync()
    return () => {
        listeners.delete(listener)
        sync()
        if (listeners.size === 0) {
            frame = 0
        }
    }
}

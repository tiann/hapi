import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    LOW_RATE_TICK_MS,
    lowRateTickerFrame,
    lowRateTickerIsRunning,
    lowRateTickerStatus,
    lowRateTickerSubscriberCount,
    subscribeLowRateTicker,
} from './lowRateTicker'

function setVisibilityState(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: state,
    })
    Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: state === 'hidden',
    })
}

/**
 * matchMedia stub whose `matches` can be flipped and whose listeners fire.
 *
 * `matchMedia` hands out a fresh object per call, exactly like the browser.
 * Real MediaQueryList objects are not identity-stable, so a stub that reuses
 * one object hides bugs where a stale list is cached or its listener removed.
 */
function installMatchMedia(initialMatches: boolean) {
    const listeners = new Set<() => void>()
    let matches = initialMatches
    const createQuery = (): MediaQueryList => ({
        get matches() { return matches },
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
        removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
        addListener: (listener: () => void) => { listeners.add(listener) },
        removeListener: (listener: () => void) => { listeners.delete(listener) },
        dispatchEvent: () => false,
    }) as unknown as MediaQueryList
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: () => createQuery(),
    })
    return {
        setMatches(next: boolean) {
            matches = next
            for (const listener of Array.from(listeners)) listener()
        },
        listenerCount: () => listeners.size,
    }
}

const originalMatchMedia = window.matchMedia

beforeEach(() => {
    vi.useFakeTimers()
    setVisibilityState('visible')
    installMatchMedia(false)
})

afterEach(() => {
    vi.useRealTimers()
    setVisibilityState('visible')
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
    })
})

describe('lowRateTicker', () => {
    it('starts the shared interval on the first subscriber and clears it on the last', () => {
        expect(lowRateTickerSubscriberCount()).toBe(0)
        expect(lowRateTickerIsRunning()).toBe(false)

        const first = vi.fn()
        const unsubscribeFirst = subscribeLowRateTicker(first)
        expect(lowRateTickerSubscriberCount()).toBe(1)
        expect(lowRateTickerIsRunning()).toBe(true)

        const second = vi.fn()
        const unsubscribeSecond = subscribeLowRateTicker(second)
        expect(lowRateTickerSubscriberCount()).toBe(2)
        // Still exactly one interval for every subscriber.
        expect(vi.getTimerCount()).toBe(1)

        unsubscribeFirst()
        expect(lowRateTickerIsRunning()).toBe(true)
        expect(lowRateTickerSubscriberCount()).toBe(1)

        unsubscribeSecond()
        expect(lowRateTickerSubscriberCount()).toBe(0)
        expect(lowRateTickerIsRunning()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('ticks every 125ms with an incrementing frame counter', () => {
        const frames: number[] = []
        const unsubscribe = subscribeLowRateTicker((frame) => frames.push(frame))

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 3)

        expect(frames).toEqual([1, 2, 3])
        unsubscribe()
        expect(lowRateTickerFrame()).toBe(0)
    })

    it('pauses while the document is hidden and resumes on visibility', () => {
        const frames: number[] = []
        const unsubscribe = subscribeLowRateTicker((frame) => frames.push(frame))

        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(frames).toEqual([1])

        setVisibilityState('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(lowRateTickerIsRunning()).toBe(false)
        expect(lowRateTickerStatus()).toBe('paused')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 10)
        expect(frames).toEqual([1])

        setVisibilityState('visible')
        document.dispatchEvent(new Event('visibilitychange'))
        expect(lowRateTickerIsRunning()).toBe(true)
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(frames).toEqual([1, 2])

        unsubscribe()
    })

    it('stays static under prefers-reduced-motion and never starts the interval', () => {
        const media = installMatchMedia(true)
        const listener = vi.fn()
        const unsubscribe = subscribeLowRateTicker(listener)

        expect(lowRateTickerIsRunning()).toBe(false)
        expect(lowRateTickerStatus()).toBe('reduced-motion')
        expect(vi.getTimerCount()).toBe(0)

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 10)
        expect(listener).not.toHaveBeenCalled()

        // Turning the preference off mid-session starts motion again.
        media.setMatches(false)
        expect(lowRateTickerIsRunning()).toBe(true)
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(listener).toHaveBeenCalledTimes(1)

        unsubscribe()
        // The shared listener is bound once per subscription and released with it,
        // even though every `matchMedia` call returns a different object.
        expect(media.listenerCount()).toBe(0)
    })

    it('keeps its change listener attached when matchMedia returns a fresh object per call', () => {
        const media = installMatchMedia(false)
        const listener = vi.fn()
        const unsubscribe = subscribeLowRateTicker(listener)

        expect(media.listenerCount()).toBe(1)
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(listener).toHaveBeenCalledTimes(1)

        // The preference turns on while subscribed and the browser notifies the
        // list it handed to us: the ticker must stop and the indicator go static.
        media.setMatches(true)
        expect(lowRateTickerIsRunning()).toBe(false)
        expect(lowRateTickerStatus()).toBe('reduced-motion')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 10)
        expect(listener).toHaveBeenCalledTimes(1)

        // ... and resume once the preference is disabled again.
        media.setMatches(false)
        expect(lowRateTickerIsRunning()).toBe(true)
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(listener).toHaveBeenCalledTimes(2)

        // Exactly one listener, registered on the list we keep for our lifetime.
        expect(media.listenerCount()).toBe(1)

        unsubscribe()
        expect(media.listenerCount()).toBe(0)
    })

    it('does not leak timers or listeners across subscribe/unsubscribe cycles', () => {
        for (let i = 0; i < 3; i += 1) {
            const unsubscribe = subscribeLowRateTicker(() => {})
            vi.advanceTimersByTime(LOW_RATE_TICK_MS)
            unsubscribe()
        }
        expect(vi.getTimerCount()).toBe(0)
        expect(lowRateTickerSubscriberCount()).toBe(0)
    })
})

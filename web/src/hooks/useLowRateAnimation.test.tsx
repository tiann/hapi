import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOW_RATE_TICK_MS, subscribeLowRateTicker } from '@/lib/lowRateTicker'
import { useLowRateAnimation, type LowRateAnimationKind } from './useLowRateAnimation'

function Indicator({ kind, enabled = true }: { kind: LowRateAnimationKind; enabled?: boolean }) {
    const ref = useRef<HTMLSpanElement | null>(null)
    useLowRateAnimation(ref, kind, enabled)
    return <span data-testid="indicator" ref={ref} />
}

const originalMatchMedia = window.matchMedia

beforeEach(() => {
    vi.useFakeTimers()
    // The ticker's frame counter is module state shared across tests; a
    // subscribe/unsubscribe pair drains it back to zero.
    subscribeLowRateTicker(() => {})()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
    })
})

describe('useLowRateAnimation', () => {
    it('spins in 22.5 degree steps over fake timers', () => {
        const { getByTestId } = render(<Indicator kind="spin" />)
        const element = getByTestId('indicator')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.transform).toBe('rotate(22.5deg)')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.transform).toBe('rotate(45deg)')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 2)
        expect(element.style.transform).toBe('rotate(90deg)')
    })

    it('pulses opacity 1 for eight frames then 0.5 for eight', () => {
        const { getByTestId } = render(<Indicator kind="pulse" />)
        const element = getByTestId('indicator')

        // Static opacity while no tick has landed.
        expect(element.style.opacity).toBe('1')
        // Frames 1-8 stay high.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 8)
        expect(element.style.opacity).toBe('1')

        // Frames 9-16 drop to 0.5.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.opacity).toBe('0.5')
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 7)
        expect(element.style.opacity).toBe('0.5')

        // Frame 17 back to high.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.opacity).toBe('1')
    })

    it('drifts stripes by tile/40 per tick, one 8px tile per 5 s', () => {
        const { getByTestId } = render(<Indicator kind="stripes" />)
        const element = getByTestId('indicator')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.backgroundPosition).toBe('0.2px 0.2px')
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 2)
        expect(element.style.backgroundPosition).toBe('0.6px 0.6px')

        // After 40 ticks (5 s at 8 Hz) the offset is exactly one tile, so the
        // loop boundary is seamless.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 37)
        expect(element.style.backgroundPosition).toBe('8px 8px')
    })

    it('does not subscribe while disabled, and starts when enabled flips', () => {
        const { getByTestId, rerender } = render(<Indicator kind="spin" enabled={false} />)
        const element = getByTestId('indicator')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 4)
        expect(element.style.transform).toBe('')

        rerender(<Indicator kind="spin" enabled />)
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.transform).toBe('rotate(22.5deg)')

        // Disabling again resets to the resting state instead of freezing mid-turn.
        rerender(<Indicator kind="spin" enabled={false} />)
        expect(element.style.transform).toBe('')
    })

    it('resets a pulsing element to full opacity when disabled', () => {
        const { getByTestId, rerender } = render(<Indicator kind="pulse" />)
        const element = getByTestId('indicator')

        // Frames 1-8 stay high, so frame 9 is the first low one.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 9)
        expect(element.style.opacity).toBe('0.5')

        rerender(<Indicator kind="pulse" enabled={false} />)
        expect(element.style.opacity).toBe('1')
    })

    it('stops receiving ticks once unmounted', () => {
        const { getByTestId, unmount } = render(<Indicator kind="spin" />)
        const element = getByTestId('indicator')

        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.transform).toBe('rotate(22.5deg)')

        unmount()
        // No timer left to fire, and the detached element is untouched.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 5)
        expect(element.style.transform).toBe('rotate(22.5deg)')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('renders static under prefers-reduced-motion', () => {
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: () => ({
                matches: true,
                media: '(prefers-reduced-motion: reduce)',
                onchange: null,
                addEventListener() {},
                removeEventListener() {},
                addListener() {},
                removeListener() {},
                dispatchEvent() { return false },
            }),
        })

        const spin = render(<Indicator kind="spin" />).container.querySelector('[data-testid="indicator"]') as HTMLElement
        const pulse = render(<Indicator kind="pulse" />).container.querySelector('[data-testid="indicator"]') as HTMLElement

        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 6)
        expect(vi.getTimerCount()).toBe(0)
        // Static, not mid-cycle.
        expect(spin.style.transform).toBe('')
        expect(pulse.style.opacity).toBe('1')
    })
})

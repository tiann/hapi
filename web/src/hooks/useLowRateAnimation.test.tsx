import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOW_RATE_TICK_MS, subscribeLowRateTicker } from '@/lib/lowRateTicker'
import { setIndicatorSmoothing } from '@/hooks/useLowRateAnimation'
import { PING_TOTAL_FRAMES, useLowRateAnimation, type LowRateAnimationKind } from './useLowRateAnimation'

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

    it('breathes opacity in a smooth triangle wave across the cycle', () => {
        const { getByTestId } = render(<Indicator kind="pulse" />)
        const element = getByTestId('indicator')

        // Static opacity while no tick has landed.
        expect(element.style.opacity).toBe('1')
        // Frame 1: at the peak, starting the descent.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS)
        expect(element.style.opacity).toBe('1')
        // Mid-descent (frame 5 of 16, phase 0.25): opacity interpolates.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 4)
        expect(element.style.opacity).toBe('0.75')
        // Trough (frame 9, phase 0.5): fully dimmed.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 4)
        expect(element.style.opacity).toBe('0.5')
        // Mid-ascent (frame 13, phase 0.75): back at 0.75.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 4)
        expect(element.style.opacity).toBe('0.75')
        // Cycle wraps (frame 17 = frame 1): peak again.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 4)
        expect(element.style.opacity).toBe('1')
        // Compositor transition smooths between ticks.
        expect(element.style.transition).toContain('opacity 125ms')
    })

    it('falls back to the square-wave cadence when smoothing is off', () => {
        setIndicatorSmoothing(false)
        try {
            const { getByTestId } = render(<Indicator kind="pulse" />)
            const element = getByTestId('indicator')

            // Frames 1-8 stay high, 9-16 drop low — the original #2447 shape.
            vi.advanceTimersByTime(LOW_RATE_TICK_MS * 8)
            expect(element.style.opacity).toBe('1')
            expect(element.style.transition).toBe('')
            vi.advanceTimersByTime(LOW_RATE_TICK_MS)
            expect(element.style.opacity).toBe('0.5')
        } finally {
            setIndicatorSmoothing(true)
        }
    })

    it('steps the spinner without a transition when smoothing is off', () => {
        setIndicatorSmoothing(false)
        try {
            const { getByTestId } = render(<Indicator kind="spin" />)
            const element = getByTestId('indicator')

            vi.advanceTimersByTime(LOW_RATE_TICK_MS)
            expect(element.style.transform).toBe('rotate(22.5deg)')
            expect(element.style.transition).toBe('')
        } finally {
            setIndicatorSmoothing(true)
        }
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

    it('expands then fades from its own first frame when joining a running ticker', () => {
        // Another indicator already drives the shared ticker, so the halo
        // subscribes at a nonzero shared frame. It must still start at its own
        // frame 1 and never receive a frame below 1.
        const stopHelper = subscribeLowRateTicker(() => {})
        // Seven ticks so the halo's first tick lands on shared frame 8: the
        // review's example, where the offset logic sets pingFrame to -7.
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 7)

        const { getByTestId } = render(<Indicator kind="ping" />)
        const element = getByTestId('indicator')

        // One cycle is PING_TOTAL_FRAMES ticks. Scale must stay in [1, 2] and
        // opacity in [0, 1] on every write, expanding then fading over two
        // full cycles.
        const scales: number[] = []
        const opacities: number[] = []
        for (let tick = 0; tick < PING_TOTAL_FRAMES * 2; tick += 1) {
            vi.advanceTimersByTime(LOW_RATE_TICK_MS)
            const scale = Number(/scale\(([\d.]+)\)/.exec(element.style.transform)?.[1])
            const opacity = Number(element.style.opacity)
            expect(scale).toBeGreaterThanOrEqual(1)
            expect(scale).toBeLessThanOrEqual(2)
            expect(opacity).toBeGreaterThanOrEqual(0)
            expect(opacity).toBeLessThanOrEqual(1)
            scales.push(scale)
            opacities.push(opacity)
        }

        // First tick after subscribing is frame 1: at rest, fully opaque.
        expect(scales[0]).toBe(1)
        expect(opacities[0]).toBe(1)
        // It expands monotonically to full scale and then fades across each cycle.
        expect(scales[PING_TOTAL_FRAMES - 1]).toBeGreaterThan(scales[0])
        expect(opacities[PING_TOTAL_FRAMES - 1]).toBeLessThan(opacities[0])
        // And the cycle repeats (two cycles observed).
        expect(scales[PING_TOTAL_FRAMES]).toBe(scales[0])
        expect(opacities[PING_TOTAL_FRAMES]).toBe(opacities[0])

        stopHelper()
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

        // Descend into the trough (frame 9, phase 0.5).
        vi.advanceTimersByTime(LOW_RATE_TICK_MS * 9)
        expect(element.style.opacity).toBe('0.5')

        rerender(<Indicator kind="pulse" enabled={false} />)
        expect(element.style.opacity).toBe('1')
        // The smoothing transition is cleared so the reset is instant.
        expect(element.style.transition).toBe('')
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

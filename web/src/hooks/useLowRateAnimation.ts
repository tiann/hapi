import { useEffect, type RefObject } from 'react'
import { LOW_RATE_TICK_MS, subscribeLowRateTicker } from '@/lib/lowRateTicker'

/**
 * Idle indicator motion, driven by the one shared low-rate ticker instead of a
 * running CSS animation (see `@/lib/lowRateTicker`). Sizes, colors and layouts
 * are unchanged: only the property that used to animate is written here.
 */
export type LowRateAnimationKind = 'spin' | 'pulse' | 'stripes'

/** The subset of an element the writers touch; satisfied by HTML and SVG alike. */
type AnimatableElement = Element & { style: CSSStyleDeclaration }

/** Each step below is derived from the cycle length of the CSS loop this hook
 *  replaced, so the motion keeps its original speed on the 8 Hz ticker. */
const TICKS_PER_SECOND = 1000 / LOW_RATE_TICK_MS
/** One turn per 2 s, matching the old `spin 2s linear infinite`: 22.5°/tick. */
const SPIN_PERIOD_S = 2
const SPIN_STEP_DEGREES = 360 / (SPIN_PERIOD_S * TICKS_PER_SECOND)
/** A 2 s cycle — half a period up, half down — 8 frames at 1, 8 at 0.5, like Tailwind's pulse. */
const PULSE_PERIOD_S = 2
const PULSE_TOTAL_FRAMES = PULSE_PERIOD_S * TICKS_PER_SECOND
const PULSE_HIGH_FRAMES = PULSE_TOTAL_FRAMES / 2
const PULSE_LOW_OPACITY = 0.5
/**
 * One tile per 5 s, matching the old stripe drift. tile/40 per tick moves on
 * every tick — the smoothest option (a whole tile every 40 ticks, or 0.4px
 * every 2 ticks, would step visibly instead of drifting).
 */
const STRIPES_PERIOD_S = 5
const STRIPES_TICKS_PER_TILE = STRIPES_PERIOD_S * TICKS_PER_SECOND
/** Must equal one background-size tile, or the loop visibly jumps. */
const STRIPES_TILE_PX = 8

/** Static geometry for the indeterminate attached-job stripes. */
export const LOW_RATE_STRIPES_CLASS = 'attached-job-stripes'

function writeSpin(element: AnimatableElement, frame: number): void {
    element.style.transform = `rotate(${frame * SPIN_STEP_DEGREES}deg)`
}

function writePulse(element: AnimatableElement, frame: number): void {
    // Frames are 1-based, so this makes ticks 1-8 high and 9-16 low.
    const high = (frame - 1) % PULSE_TOTAL_FRAMES < PULSE_HIGH_FRAMES
    element.style.opacity = high ? '1' : String(PULSE_LOW_OPACITY)
}

function writeStripes(element: AnimatableElement, frame: number): void {
    // Multiply before dividing: frame * (tile / 40) would accumulate float
    // noise (3 * 0.2 === 0.6000000000000001) and dirty the style string.
    const offset = (frame * STRIPES_TILE_PX) / STRIPES_TICKS_PER_TILE
    // Both axes move by the same amount so the -45° diagonal phase matches at
    // the loop boundary (same reasoning as the keyframes this replaced).
    element.style.backgroundPosition = `${offset}px ${offset}px`
}

const WRITERS: Record<LowRateAnimationKind, (element: AnimatableElement, frame: number) => void> = {
    spin: writeSpin,
    pulse: writePulse,
    stripes: writeStripes,
}

/** Reset to the resting state so a disabled/reduced-motion indicator is static. */
function writeStatic(element: AnimatableElement, kind: LowRateAnimationKind): void {
    if (kind === 'pulse') {
        element.style.opacity = '1'
    } else if (kind === 'spin') {
        element.style.transform = ''
    } else {
        element.style.backgroundPosition = ''
    }
}

/**
 * Attach a low-rate idle animation to `ref`. The element is mutated directly on
 * each tick — no React state, so a full session list never re-renders. When the
 * ticker does not run (reduced motion), the element keeps its static inline
 * styles (opacity 1 for pulse, no rotation for spin) instead of the mid-cycle
 * `0.5`/off-phase frame that pausing the shared frame would otherwise imply.
 */
export function useLowRateAnimation(
    ref: RefObject<AnimatableElement | null>,
    kind: LowRateAnimationKind,
    /** Skip subscribing while this indicator is not animating in this render. */
    enabled = true
): void {
    useEffect(() => {
        const element = ref.current
        if (!enabled) {
            // A previously animated element (e.g. the presence badge before the
            // row became unread) must not keep a half-cycle opacity/rotation.
            if (element) writeStatic(element, kind)
            return
        }
        if (!element) return

        writeStatic(element, kind)
        return subscribeLowRateTicker((frame) => {
            const target = ref.current
            if (!target) return
            WRITERS[kind](target, frame)
        })
    }, [ref, kind, enabled])
}

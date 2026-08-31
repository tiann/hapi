/**
 * Short "something is blocked" tone for the session list (#1717).
 *
 * Synthesised with WebAudio rather than shipped as an asset: no bytes added to
 * the bundle, no network fetch, works offline in the PWA, and the shape can be
 * tuned in code. Two descending square-wave beeps — deliberately the old
 * error-buzzer idiom, so it reads as "go look" and not as a notification chime
 * that blends into every other app.
 */

const TONE_HZ = [660, 440] as const
const BEEP_MS = 110
const GAP_MS = 70
const PEAK_GAIN = 0.09

/** Never more than one tone per this window, however many blockers land at once. */
export const BLOCKED_SOUND_THROTTLE_MS = 4000

// -Infinity, not 0: with 0 the first call is throttled whenever `now` is
// smaller than the window, which is every injected clock and would have made
// the very first blocker of a session silent under a fake timer.
let lastPlayedAt = Number.NEGATIVE_INFINITY
let context: AudioContext | null = null

type AudioContextCtor = new () => AudioContext

function getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (context) return context
    const Ctor: AudioContextCtor | undefined =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
    if (!Ctor) return null
    try {
        context = new Ctor()
    } catch {
        return null
    }
    return context
}

/**
 * Play the blocked tone, unless one played inside the throttle window.
 * Returns whether a tone was actually started.
 *
 * Fails silently and reports false when the browser has not yet granted audio
 * (no user gesture): an alert sound is never worth an unhandled rejection, and
 * the visual pulse still fires.
 */
export function playBlockedAlertSound(now: number = Date.now()): boolean {
    if (now - lastPlayedAt < BLOCKED_SOUND_THROTTLE_MS) return false
    const ctx = getAudioContext()
    if (!ctx) return false

    try {
        // Autoplay policy rejects resume() until a user gesture. Swallow it:
        // the docstring promises this never throws, and an unhandled rejection
        // over an alert tone is worse than a silent one.
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})

        TONE_HZ.forEach((hz, index) => {
            const startAt = ctx.currentTime + (index * (BEEP_MS + GAP_MS)) / 1000
            const endAt = startAt + BEEP_MS / 1000
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.type = 'square'
            osc.frequency.setValueAtTime(hz, startAt)
            // Ramp the envelope rather than gating hard — an instant square-wave
            // start/stop clicks audibly on most output devices.
            gain.gain.setValueAtTime(0.0001, startAt)
            gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startAt + 0.012)
            gain.gain.exponentialRampToValueAtTime(0.0001, endAt)
            osc.connect(gain)
            gain.connect(ctx.destination)
            osc.start(startAt)
            osc.stop(endAt + 0.02)
        })
    } catch {
        return false
    }

    lastPlayedAt = now
    return true
}

/** Test seam — forget the throttle window and any cached context. */
export function resetBlockedAlertSoundThrottle(): void {
    lastPlayedAt = Number.NEGATIVE_INFINITY
    context = null
}

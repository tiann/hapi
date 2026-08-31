import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    BLOCKED_SOUND_THROTTLE_MS,
    playBlockedAlertSound,
    resetBlockedAlertSoundThrottle
} from './blockedAlertSound'

type Stub = {
    started: number
    resumed: number
    state: string
}

function installAudioStub(): Stub {
    const stub: Stub = { started: 0, resumed: 0, state: 'running' }
    class FakeAudioContext {
        currentTime = 0
        get state() { return stub.state }
        resume() { stub.resumed += 1; stub.state = 'running'; return Promise.resolve() }
        createOscillator() {
            return {
                type: '',
                frequency: { setValueAtTime: () => {} },
                connect: () => {},
                start: () => { stub.started += 1 },
                stop: () => {},
            }
        }
        createGain() {
            return {
                gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
                connect: () => {},
            }
        }
        destination = {}
    }
    // @ts-expect-error test stub
    window.AudioContext = FakeAudioContext
    return stub
}

beforeEach(() => {
    resetBlockedAlertSoundThrottle()
    // @ts-expect-error test stub
    delete window.AudioContext
    // @ts-expect-error test stub
    delete window.webkitAudioContext
})

describe('playBlockedAlertSound', () => {
    it('plays a two-beep tone', () => {
        const stub = installAudioStub()
        expect(playBlockedAlertSound(1000)).toBe(true)
        expect(stub.started).toBe(2)
    })

    it('throttles a burst so a wave of blockers is one tone, not twelve', () => {
        const stub = installAudioStub()
        expect(playBlockedAlertSound(1000)).toBe(true)
        expect(playBlockedAlertSound(1500)).toBe(false)
        expect(playBlockedAlertSound(1000 + BLOCKED_SOUND_THROTTLE_MS)).toBe(true)
        expect(stub.started).toBe(4)
    })

    it('resumes a suspended context rather than silently dropping the tone', () => {
        const stub = installAudioStub()
        stub.state = 'suspended'
        expect(playBlockedAlertSound(1000)).toBe(true)
        expect(stub.resumed).toBe(1)
    })

    it('reports false instead of throwing when the browser has no WebAudio', () => {
        // Autoplay-blocked or unsupported: the visual pulse still fires, and an
        // alert sound is never worth an unhandled rejection.
        expect(playBlockedAlertSound(1000)).toBe(false)
    })

    it('reports false instead of throwing when the context constructor fails', () => {
        // @ts-expect-error test stub
        window.AudioContext = class { constructor() { throw new Error('blocked') } }
        expect(() => playBlockedAlertSound(1000)).not.toThrow()
        expect(playBlockedAlertSound(2000)).toBe(false)
    })
})

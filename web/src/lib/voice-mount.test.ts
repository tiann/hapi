import { describe, expect, it } from 'vitest'
import { shouldMountRealtimeVoiceSession } from './voice-mount'

describe('shouldMountRealtimeVoiceSession', () => {
    it('does not mount the heavy voice session on initial chat render', () => {
        expect(shouldMountRealtimeVoiceSession('disconnected', false)).toBe(false)
        expect(shouldMountRealtimeVoiceSession(null, false)).toBe(false)
    })

    it('mounts the heavy voice session after the user starts voice', () => {
        expect(shouldMountRealtimeVoiceSession('disconnected', true)).toBe(true)
        expect(shouldMountRealtimeVoiceSession('connecting', false)).toBe(true)
        expect(shouldMountRealtimeVoiceSession('connected', false)).toBe(true)
    })
})

import { describe, expect, it, beforeEach } from 'vitest'
import { getSessionLastSeenAt, markSessionSeen } from './sessionLastSeen'

describe('sessionLastSeen', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('stores the latest seen timestamp for a session', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-a', 2500)
        expect(getSessionLastSeenAt('session-a')).toBe(2500)
    })

    it('does not move the watermark backwards', () => {
        markSessionSeen('session-a', 5000)
        markSessionSeen('session-a', 2000)
        expect(getSessionLastSeenAt('session-a')).toBe(5000)
    })
})

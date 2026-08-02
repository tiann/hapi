import { describe, expect, it } from 'vitest'
import { getSupersedingSessionId, shouldFollowSupersedingSession } from './followSupersedingSession'

describe('getSupersedingSessionId', () => {
    it('follows a different persisted replacement identity', () => {
        expect(getSupersedingSessionId('source', { supersededBySessionId: 'fresh' })).toBe('fresh')
    })

    it('does not self-navigate for missing, blank, or identical values', () => {
        expect(getSupersedingSessionId('source', undefined)).toBeNull()
        expect(getSupersedingSessionId('source', { supersededBySessionId: '  ' })).toBeNull()
        expect(getSupersedingSessionId('source', { supersededBySessionId: 'source' })).toBeNull()
    })
})

describe('shouldFollowSupersedingSession', () => {
    it('follows a replacement only when the open view witnessed the source session before supersession', () => {
        expect(shouldFollowSupersedingSession({
            sessionId: 'source',
            supersedingSessionId: null
        }, 'source', {
            supersededBySessionId: 'fresh'
        })).toBe(true)
    })

    it('keeps an archived conversation accessible when opened after it was already superseded', () => {
        expect(shouldFollowSupersedingSession(null, 'source', {
            supersededBySessionId: 'fresh'
        })).toBe(false)
        expect(shouldFollowSupersedingSession({
            sessionId: 'other-session',
            supersedingSessionId: null
        }, 'source', {
            supersededBySessionId: 'fresh'
        })).toBe(false)
        expect(shouldFollowSupersedingSession({
            sessionId: 'source',
            supersedingSessionId: 'fresh'
        }, 'source', {
            supersededBySessionId: 'fresh'
        })).toBe(false)
    })
})

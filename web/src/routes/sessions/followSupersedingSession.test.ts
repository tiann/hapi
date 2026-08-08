import { describe, expect, it, afterEach } from 'vitest'
import {
    getSupersedingSessionId,
    prepareFollowSupersedingSession,
    shouldFollowSupersedingSession,
} from './followSupersedingSession'
import {
    consumeSharePendingTransfer,
    setSharePendingTransfer,
} from '@/lib/sharePendingState'

afterEach(() => {
    try { window.sessionStorage.clear() } catch { /* noop */ }
})

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

describe('prepareFollowSupersedingSession', () => {
    it('retargets a pending share transfer before the automatic A→B navigation', () => {
        setSharePendingTransfer('xfer-share', 'source')
        const shouldFollow = shouldFollowSupersedingSession({
            sessionId: 'source',
            supersedingSessionId: null,
        }, 'source', {
            supersededBySessionId: 'fresh',
        })
        expect(shouldFollow).toBe(true)

        prepareFollowSupersedingSession('source', 'fresh')

        expect(consumeSharePendingTransfer('source')).toBeNull()
        expect(consumeSharePendingTransfer('fresh')).toBe('xfer-share')
    })
})

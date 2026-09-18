import { describe, expect, it } from 'bun:test'
import {
    SESSION_SIZE_HARD_MAX_CONTENT_BYTES,
    SESSION_SIZE_HARD_MAX_MESSAGES,
    SESSION_SIZE_SOFT_MAX_CONTENT_BYTES,
    SESSION_SIZE_SOFT_MAX_MESSAGES,
    evaluateSessionSize,
    sessionSizeGuardMessage
} from './sessionSizeGuard'

describe('evaluateSessionSize', () => {
    it('returns ok for small sessions', () => {
        expect(evaluateSessionSize({ messageCount: 0, contentBytes: 0 })).toBe('ok')
        expect(evaluateSessionSize({ messageCount: 200, contentBytes: 512 * 1024 })).toBe('ok')
    })

    it('treats the thresholds as inclusive-ok boundaries', () => {
        expect(evaluateSessionSize({
            messageCount: SESSION_SIZE_SOFT_MAX_MESSAGES,
            contentBytes: SESSION_SIZE_SOFT_MAX_CONTENT_BYTES
        })).toBe('ok')
        expect(evaluateSessionSize({
            messageCount: SESSION_SIZE_HARD_MAX_MESSAGES,
            contentBytes: SESSION_SIZE_HARD_MAX_CONTENT_BYTES
        })).toBe('soft')
    })

    it('flags soft when either message count or bytes exceeds the soft threshold', () => {
        expect(evaluateSessionSize({
            messageCount: SESSION_SIZE_SOFT_MAX_MESSAGES + 1,
            contentBytes: 0
        })).toBe('soft')
        expect(evaluateSessionSize({
            messageCount: 1,
            contentBytes: SESSION_SIZE_SOFT_MAX_CONTENT_BYTES + 1
        })).toBe('soft')
    })

    it('flags hard when either message count or bytes exceeds the hard threshold', () => {
        expect(evaluateSessionSize({
            messageCount: SESSION_SIZE_HARD_MAX_MESSAGES + 1,
            contentBytes: 0
        })).toBe('hard')
        expect(evaluateSessionSize({
            messageCount: 1,
            contentBytes: SESSION_SIZE_HARD_MAX_CONTENT_BYTES + 1
        })).toBe('hard')
        // Incident shape: ~212k messages / ~214 MB.
        expect(evaluateSessionSize({
            messageCount: 212_000,
            contentBytes: 214 * 1024 * 1024
        })).toBe('hard')
    })

    it('describes both tiers with the measured size', () => {
        const stats = { messageCount: 212_000, contentBytes: 214 * 1024 * 1024 }
        expect(sessionSizeGuardMessage(stats, 'hard')).toContain('212000 messages / 214.0 MB')
        expect(sessionSizeGuardMessage(stats, 'hard')).toContain('hard resume limit')
        expect(sessionSizeGuardMessage(stats, 'soft')).toContain('confirmation threshold')
    })
})

import { describe, expect, it } from 'vitest'
import type { Session, SessionSummary } from '@/types/api'
import {
    needsSessionResponseRetry,
    shouldAcceptSessionRecord,
} from './sessionCache'

function session(seq: number): Session {
    return { id: 'session-1', seq } as Session
}

function summary(lastAssistantMessageVersion: number): SessionSummary {
    return {
        id: 'session-1',
        lastAssistantMessageVersion,
    } as SessionSummary
}

describe('session cache cross-cache reply-clock watermarks', () => {
    it('rejects an older full detail record when the list summary is newer', () => {
        expect(shouldAcceptSessionRecord(undefined, session(4), summary(5))).toBe(false)
        expect(shouldAcceptSessionRecord(session(5), session(5), summary(6))).toBe(false)
        expect(shouldAcceptSessionRecord(session(5), session(6), summary(6))).toBe(true)
    })

    it('requests a bounded REST retry when only the list summary is newer', () => {
        expect(needsSessionResponseRetry(
            undefined,
            { session: session(4) },
            summary(5)
        )).toBe(true)
    })
})

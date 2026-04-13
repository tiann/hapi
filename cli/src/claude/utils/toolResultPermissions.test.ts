import { describe, expect, it, vi } from 'vitest'
import { buildClaudeToolResultPermissions } from './toolResultPermissions'

describe('buildClaudeToolResultPermissions', () => {
    it('includes approval decision and normalized metadata', () => {
        expect(buildClaudeToolResultPermissions({
            approved: true,
            receivedAt: 123,
            mode: 'acceptEdits',
            implementationMode: 'clear_context',
            allowTools: ['Edit'],
            decision: 'approved_for_session'
        })).toEqual({
            date: 123,
            result: 'approved',
            mode: 'acceptEdits',
            implementationMode: 'clear_context',
            allowedTools: ['Edit'],
            decision: 'approved_for_session'
        })
    })

    it('falls back to current time when receivedAt is absent', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-04-02T12:00:00Z'))

        expect(buildClaudeToolResultPermissions({
            approved: false,
            decision: 'abort'
        })).toEqual({
            date: Date.now(),
            result: 'denied',
            decision: 'abort'
        })

        vi.useRealTimers()
    })
})

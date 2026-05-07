import { describe, expect, it } from 'vitest'
import { clampToMaxDays, parsePreset, validateSpecificDatetime, resolvePendingSchedule } from './ScheduleTimePicker'
import type { PendingSchedule } from './ScheduleTimePicker'

/**
 * Unit tests for ScheduleTimePicker pure functions.
 * Tests the clamping, preset parsing, and validation logic independent of React.
 */
describe('parsePreset', () => {
    it('+5m returns Date.now() + 5 minutes in ms', () => {
        const now = Date.now()
        const result = parsePreset('+5m', now)
        expect(result).toBe(now + 5 * 60 * 1000)
    })

    it('+30m returns Date.now() + 30 minutes in ms', () => {
        const now = Date.now()
        const result = parsePreset('+30m', now)
        expect(result).toBe(now + 30 * 60 * 1000)
    })

    it('+1h returns Date.now() + 1 hour in ms', () => {
        const now = Date.now()
        const result = parsePreset('+1h', now)
        expect(result).toBe(now + 60 * 60 * 1000)
    })

    it('+4h returns Date.now() + 4 hours in ms', () => {
        const now = Date.now()
        const result = parsePreset('+4h', now)
        expect(result).toBe(now + 4 * 60 * 60 * 1000)
    })
})

describe('clampToMaxDays', () => {
    it('returns value unchanged when within 7 days', () => {
        const now = Date.now()
        const future = now + 2 * 24 * 60 * 60 * 1000 // 2 days
        expect(clampToMaxDays(future, now, 7)).toBe(future)
    })

    it('clamps value to now + 7 days when beyond limit', () => {
        const now = Date.now()
        const tooFar = now + 8 * 24 * 60 * 60 * 1000 // 8 days
        const expected = now + 7 * 24 * 60 * 60 * 1000
        expect(clampToMaxDays(tooFar, now, 7)).toBe(expected)
    })

    it('returns exact boundary (7 days) unchanged', () => {
        const now = Date.now()
        const boundary = now + 7 * 24 * 60 * 60 * 1000
        expect(clampToMaxDays(boundary, now, 7)).toBe(boundary)
    })
})

// ---------------------------------------------------------------------------
// #3 PendingSchedule + resolvePendingSchedule — send-time base for presets
// ---------------------------------------------------------------------------

describe('resolvePendingSchedule', () => {
    it('returns null for null input', () => {
        expect(resolvePendingSchedule(null, Date.now())).toBeNull()
    })

    it('preset: resolves delay relative to sendNow (not pick time)', () => {
        const pickTime = Date.now() - 30_000 // picked 30s ago
        const sendNow = Date.now()
        const pending: PendingSchedule = { type: 'preset', preset: '+5m' }
        const result = resolvePendingSchedule(pending, sendNow)
        // Should be sendNow + 5 min, NOT pickTime + 5 min
        expect(result).toBe(sendNow + 5 * 60 * 1000)
        // Confirm it differs from "pick-time base"
        const pickBase = pickTime + 5 * 60 * 1000
        expect(result).not.toBe(pickBase)
    })

    it('preset +30m resolves correctly', () => {
        const sendNow = 1_700_000_000_000
        const pending: PendingSchedule = { type: 'preset', preset: '+30m' }
        expect(resolvePendingSchedule(pending, sendNow)).toBe(sendNow + 30 * 60 * 1000)
    })

    it('preset +1h resolves correctly', () => {
        const sendNow = 1_700_000_000_000
        const pending: PendingSchedule = { type: 'preset', preset: '+1h' }
        expect(resolvePendingSchedule(pending, sendNow)).toBe(sendNow + 60 * 60 * 1000)
    })

    it('preset +4h resolves correctly', () => {
        const sendNow = 1_700_000_000_000
        const pending: PendingSchedule = { type: 'preset', preset: '+4h' }
        expect(resolvePendingSchedule(pending, sendNow)).toBe(sendNow + 4 * 60 * 60 * 1000)
    })

    it('absolute: returns stored ms unchanged regardless of sendNow', () => {
        const ms = 1_700_000_000_000 + 60_000
        const sendNow = 1_700_000_000_000 + 999_999 // very different from pick time
        const pending: PendingSchedule = { type: 'absolute', ms }
        expect(resolvePendingSchedule(pending, sendNow)).toBe(ms)
    })
})

describe('validateSpecificDatetime', () => {
    it('returns null for a future datetime within 7 days', () => {
        const now = Date.now()
        const future = now + 60 * 60 * 1000 // 1 hour from now
        expect(validateSpecificDatetime(future, now)).toBeNull()
    })

    it('returns error key for a past datetime', () => {
        const now = Date.now()
        const past = now - 60 * 1000
        expect(validateSpecificDatetime(past, now)).toBe('scheduleErrorPast')
    })

    it('returns error key for a datetime beyond 7 days', () => {
        const now = Date.now()
        const tooFar = now + 8 * 24 * 60 * 60 * 1000
        expect(validateSpecificDatetime(tooFar, now)).toBe('scheduleErrorTooFar')
    })

    it('returns null for datetime exactly at now + 1s (boundary)', () => {
        const now = Date.now()
        const boundary = now + 1000
        expect(validateSpecificDatetime(boundary, now)).toBeNull()
    })

    // #9: 30-second grace period — datetime-local minute resolution means the
    // selected minute can become "in the past" by the time the user clicks.
    it('#9 grace period: returns null for datetime up to 30s in the past (click delay)', () => {
        const now = Date.now()
        const slightlyPast = now - 29_000 // 29 seconds ago — within grace
        expect(validateSpecificDatetime(slightlyPast, now)).toBeNull()
    })

    it('#9 grace period: returns error for datetime more than 30s in the past', () => {
        const now = Date.now()
        const tooOld = now - 31_000 // 31 seconds ago — beyond grace
        expect(validateSpecificDatetime(tooOld, now)).toBe('scheduleErrorPast')
    })
})

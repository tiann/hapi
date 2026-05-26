import { describe, expect, it } from 'vitest'
import {
    clampToMaxDays,
    computeSchedulePickerPlacement,
    parsePreset,
    validateSpecificDatetime,
    resolvePendingSchedule
} from './ScheduleTimePicker'
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

    it('plugin preset resolves custom delayMs relative to sendNow', () => {
        const sendNow = 1_700_000_000_000
        const pending: PendingSchedule = { type: 'preset', preset: 'plugin-short-delay', delayMs: 90_000 }
        expect(resolvePendingSchedule(pending, sendNow)).toBe(sendNow + 90_000)
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

describe('computeSchedulePickerPlacement', () => {
    const panel = { panelWidth: 288, panelHeight: 180 }

    it('clamps left edge when the anchor is near the mobile viewport right side', () => {
        const placement = computeSchedulePickerPlacement({
            anchor: { top: 500, right: 368, bottom: 532, left: 336 },
            ...panel,
            viewport: { width: 375, height: 667 },
        })

        expect(placement.left).toBe(79)
        expect(placement.left + panel.panelWidth).toBeLessThanOrEqual(375 - 8)
    })

    it('opens above the anchor when there is enough room above', () => {
        const placement = computeSchedulePickerPlacement({
            anchor: { top: 500, right: 132, bottom: 532, left: 100 },
            ...panel,
            viewport: { width: 390, height: 700 },
        })

        expect(placement.placement).toBe('above')
        expect(placement.top).toBe(312)
        expect(placement.maxHeight).toBe(panel.panelHeight)
    })

    it('opens below the anchor when only below has enough room', () => {
        const placement = computeSchedulePickerPlacement({
            anchor: { top: 80, right: 132, bottom: 112, left: 100 },
            ...panel,
            viewport: { width: 390, height: 700 },
        })

        expect(placement.placement).toBe('below')
        expect(placement.top).toBe(120)
        expect(placement.maxHeight).toBe(panel.panelHeight)
    })

    it('uses the larger side with a constrained maxHeight when neither side fully fits', () => {
        const placement = computeSchedulePickerPlacement({
            anchor: { top: 140, right: 132, bottom: 172, left: 100 },
            panelWidth: 288,
            panelHeight: 260,
            viewport: { width: 390, height: 300 },
        })

        expect(placement.placement).toBe('above')
        expect(placement.top).toBe(8)
        expect(placement.maxHeight).toBe(124)
    })

    it('keeps placement inside an offset visual viewport', () => {
        const placement = computeSchedulePickerPlacement({
            anchor: { top: 260, right: 372, bottom: 292, left: 340 },
            ...panel,
            viewport: { width: 375, height: 500, offsetTop: 100, offsetLeft: 10 },
        })

        expect(placement.left).toBe(89)
        expect(placement.top).toBeGreaterThanOrEqual(108)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(600 - 8)
    })
})

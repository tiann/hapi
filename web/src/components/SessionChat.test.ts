import { describe, expect, it } from 'vitest'
import { shouldAutoClearPendingSchedule } from './SessionChat'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'

/**
 * Unit tests for shouldAutoClearPendingSchedule.
 *
 * The useEffect in SessionChat auto-clears only 'absolute' pending schedules
 * when the chosen time expires.  'preset' schedules must NOT be auto-cleared
 * because they are relative to send time and have no fixed expiry.
 *
 * This test guards against future refactors that accidentally break the
 * preset-stays-alive invariant (a silent break: the effect would cancel the
 * preset with no user-visible error before send time).
 */
describe('shouldAutoClearPendingSchedule', () => {
    it('returns false for null (no schedule set)', () => {
        expect(shouldAutoClearPendingSchedule(null)).toBe(false)
    })

    it('returns false for preset schedule — presets do not expire before send', () => {
        const preset: PendingSchedule = { type: 'preset', preset: '+5m' }
        expect(shouldAutoClearPendingSchedule(preset)).toBe(false)
    })

    it('returns false for all preset values', () => {
        const presets: Array<'+5m' | '+30m' | '+1h' | '+4h'> = ['+5m', '+30m', '+1h', '+4h']
        for (const p of presets) {
            const pending: PendingSchedule = { type: 'preset', preset: p }
            expect(shouldAutoClearPendingSchedule(pending)).toBe(false)
        }
    })

    it('returns true for absolute schedule — absolute schedules have a fixed expiry instant', () => {
        const absolute: PendingSchedule = { type: 'absolute', ms: Date.now() + 60_000 }
        expect(shouldAutoClearPendingSchedule(absolute)).toBe(true)
    })

    it('returns true for expired absolute schedule (ms in the past)', () => {
        const expired: PendingSchedule = { type: 'absolute', ms: Date.now() - 1000 }
        expect(shouldAutoClearPendingSchedule(expired)).toBe(true)
    })
})

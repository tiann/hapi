import { describe, expect, it } from 'vitest'
import {
    FAILED_HANDOFF_LOCK_DELAY_INCREMENT_MS,
    FAILED_HANDOFF_LOCK_MAX_ATTEMPTS,
    failedHandoffLockMaxBackoffMs,
} from './handoffLock'

describe('failed-handoff lock reacquire budget', () => {
    it('stays under the hub upgrade RPC timeout (and near the 30s handoff wait)', () => {
        const maxBackoffMs = failedHandoffLockMaxBackoffMs()
        // 500 * (1+…+10) = 27_500 — bot Major on (60, 500) ≈ 885s.
        expect(maxBackoffMs).toBe(27_500)
        expect(maxBackoffMs).toBeLessThan(60_000)
        expect(FAILED_HANDOFF_LOCK_MAX_ATTEMPTS).toBe(11)
        expect(FAILED_HANDOFF_LOCK_DELAY_INCREMENT_MS).toBe(500)
        // Old (60, 500) budget for regression guard.
        expect(failedHandoffLockMaxBackoffMs(60, 500)).toBe(885_000)
    })
})

import { describe, expect, it } from 'vitest'
import type { AttachedJob } from '@hapi/protocol'
import {
    ATTACHED_JOB_STALE_MS,
    attachedJobFraction,
    formatAttachedJobElapsed,
    formatAttachedJobProgress,
    formatCompactElapsed,
    isAttachedJobStale
} from './attachedJob'

function job(overrides: Partial<AttachedJob> = {}): AttachedJob {
    return {
        key: 'beets',
        label: 'beets import',
        status: 'running',
        heartbeatAt: 1_000,
        startedAt: 1_000,
        updatedAt: 1_000,
        ...overrides
    }
}

describe('attachedJob helpers', () => {
    it('formats compact elapsed without inventing ETA', () => {
        expect(formatCompactElapsed(0)).toBe('0s')
        expect(formatCompactElapsed(45_000)).toBe('45s')
        expect(formatCompactElapsed(5 * 60_000)).toBe('5m')
        expect(formatCompactElapsed(3 * 60 * 60_000 + 12 * 60_000)).toBe('3h 12m')
        expect(formatCompactElapsed(3 * 60 * 60_000)).toBe('3h')
        expect(formatCompactElapsed(2 * 24 * 60 * 60_000 + 4 * 60 * 60_000)).toBe('2d 4h')
        expect(formatCompactElapsed(2 * 24 * 60 * 60_000)).toBe('2d')
        expect(formatCompactElapsed(-1)).toBe('0s')
    })

    it('formats remaining count with elapsed', () => {
        const now = 1_000 + 2 * 60 * 60_000
        expect(formatAttachedJobProgress(
            job({ remaining: 120, unit: 'tracks', heartbeatAt: now - 60_000 }),
            now
        )).toBe('120 tracks left · 2h')
    })

    it('formats done/total with derived percent and elapsed', () => {
        const now = 1_000 + 45 * 60_000
        expect(formatAttachedJobProgress(
            job({ done: 800, total: 900, unit: 'tracks', heartbeatAt: now - 60_000 }),
            now
        )).toBe('89% · 800/900 tracks · 45m')
    })

    it('falls back to running + elapsed when only heartbeat', () => {
        const now = 1_000 + 90_000
        expect(formatAttachedJobProgress(job({ heartbeatAt: now - 30_000 }), now)).toBe('running · 1m')
        expect(formatAttachedJobElapsed(job(), now)).toBe('1m')
    })

    it('computes fraction from remaining+total', () => {
        expect(attachedJobFraction(job({ remaining: 100, total: 1000 }))).toBe(0.9)
    })

    it('prefers remaining over stale done when both are present', () => {
        // PATCH that only updates remaining preserves an older done — bar must match label.
        expect(attachedJobFraction(job({ remaining: 100, total: 1000, done: 200 }))).toBe(0.9)
    })

    it('marks stale after heartbeat window', () => {
        const now = 1_000 + ATTACHED_JOB_STALE_MS + 1
        expect(isAttachedJobStale(job({ heartbeatAt: 1_000 }), now)).toBe(true)
        expect(isAttachedJobStale(job({ heartbeatAt: now - 60_000 }), now)).toBe(false)
    })

    it('appends no-heartbeat age when stale so frozen counts are obvious', () => {
        const heartbeatAt = 1_000
        const now = heartbeatAt + ATTACHED_JOB_STALE_MS + 60 * 60_000
        expect(
            formatAttachedJobProgress(
                job({ done: 3700, total: 4441, heartbeatAt, startedAt: heartbeatAt }),
                now
            )
        ).toBe('83% · 3700/4441 · 1h 15m · no heartbeat · 1h 15m')
    })
})

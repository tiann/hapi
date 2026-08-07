import { describe, expect, it } from 'vitest'
import type { AttachedJob } from '@hapi/protocol'
import {
    ATTACHED_JOB_STALE_MS,
    attachedJobFraction,
    formatAttachedJobProgress,
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
    it('formats remaining count without inventing percent', () => {
        expect(formatAttachedJobProgress(job({ remaining: 120, unit: 'tracks' }))).toBe('120 tracks left')
    })

    it('formats done/total with derived percent', () => {
        expect(formatAttachedJobProgress(job({ done: 800, total: 900, unit: 'tracks' }))).toBe(
            '89% · 800/900 tracks'
        )
    })

    it('falls back to running when only heartbeat', () => {
        expect(formatAttachedJobProgress(job())).toBe('running')
    })

    it('computes fraction from remaining+total', () => {
        expect(attachedJobFraction(job({ remaining: 100, total: 1000 }))).toBe(0.9)
    })

    it('marks stale after heartbeat window', () => {
        const now = 1_000 + ATTACHED_JOB_STALE_MS + 1
        expect(isAttachedJobStale(job({ heartbeatAt: 1_000 }), now)).toBe(true)
        expect(isAttachedJobStale(job({ heartbeatAt: now - 60_000 }), now)).toBe(false)
    })
})

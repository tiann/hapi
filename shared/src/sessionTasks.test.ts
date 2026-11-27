import { describe, expect, it } from 'bun:test'
import {
    buildSessionTaskMessageLocalId,
    checkSessionTaskStartAt,
    CreateSessionTaskRequestSchema,
    isSessionTaskMessageLocalId,
    nextRepeatRunAt,
    SESSION_TASK_MAX_ITEMS,
    SESSION_TASK_MAX_START_OFFSET_MS,
    SESSION_TASK_MAX_TEXT_LENGTH,
    SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX,
    SessionTaskDeleteResponseSchema,
    SessionTaskErrorCodeSchema,
    SessionTaskRunListQuerySchema,
    SessionTaskRunSchema,
    SessionTaskSchema,
    UpdateSessionTaskRequestSchema
} from './sessionTasks'

const MINUTE = 60_000

describe('nextRepeatRunAt', () => {
    it('moves one interval when the slot ran on time', () => {
        expect(nextRepeatRunAt(1_000, 10 * MINUTE, 1_000)).toBe(1_000 + 10 * MINUTE)
        expect(nextRepeatRunAt(1_000, 10 * MINUTE, 1_000 + 5 * MINUTE)).toBe(1_000 + 10 * MINUTE)
    })

    it('skips the slots a late run missed instead of catching them up', () => {
        const anchor = 1_000
        // The hub was down for two and a half hours.
        expect(nextRepeatRunAt(anchor, 10 * MINUTE, anchor + 150 * MINUTE)).toBe(anchor + 160 * MINUTE)
        expect(nextRepeatRunAt(anchor, 10 * MINUTE, anchor + 150 * MINUTE + 1)).toBe(anchor + 160 * MINUTE)
    })

    it('leaves a future slot alone', () => {
        expect(nextRepeatRunAt(5_000, MINUTE, 1_000)).toBe(5_000)
    })

    it('falls back to now without a usable anchor', () => {
        expect(nextRepeatRunAt(Number.NaN, MINUTE, 7_000)).toBe(7_000)
        expect(nextRepeatRunAt(1_000, 0, 7_000)).toBe(7_000)
    })
})

describe('session task message ids', () => {
    it('builds and recognises the localId of a task prompt', () => {
        const localId = buildSessionTaskMessageLocalId('abc', 3)
        expect(localId).toBe(`${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}abc:3`)
        expect(isSessionTaskMessageLocalId(localId)).toBe(true)
        expect(isSessionTaskMessageLocalId('hapi-job-wake:abc:3')).toBe(false)
        expect(isSessionTaskMessageLocalId(null)).toBe(false)
        expect(isSessionTaskMessageLocalId(undefined)).toBe(false)
    })
})

describe('checkSessionTaskStartAt', () => {
    const now = 1_700_000_000_000

    it('accepts now, the near past and anything up to the horizon', () => {
        expect(checkSessionTaskStartAt(now, now)).toBeNull()
        expect(checkSessionTaskStartAt(now - 59_000, now)).toBeNull()
        expect(checkSessionTaskStartAt(now + SESSION_TASK_MAX_START_OFFSET_MS, now)).toBeNull()
    })

    it('rejects a start too far in the past or the future', () => {
        expect(checkSessionTaskStartAt(now - 61_000, now)).toBe('past')
        expect(checkSessionTaskStartAt(now + SESSION_TASK_MAX_START_OFFSET_MS + 1, now)).toBe('too-far')
    })
})

describe('CreateSessionTaskRequestSchema', () => {
    it('accepts a repeat task with optional first run and run limit', () => {
        const parsed = CreateSessionTaskRequestSchema.parse({
            kind: 'repeat',
            text: 'check progress',
            intervalMs: 30 * MINUTE,
            startAt: 1_700_000_000_000,
            maxRuns: 5
        })
        expect(parsed).toEqual({
            kind: 'repeat',
            text: 'check progress',
            intervalMs: 30 * MINUTE,
            startAt: 1_700_000_000_000,
            maxRuns: 5
        })
        expect(CreateSessionTaskRequestSchema.parse({ kind: 'repeat', text: 'ping', intervalMs: MINUTE }))
            .toEqual({ kind: 'repeat', text: 'ping', intervalMs: MINUTE })
    })

    it('accepts a queue task', () => {
        expect(CreateSessionTaskRequestSchema.parse({
            kind: 'queue',
            items: [{ text: 'first' }, { text: '你好' }, { text: '吃饭了吗？' }],
            intervalMs: 10 * MINUTE
        })).toEqual({
            kind: 'queue',
            items: [{ text: 'first' }, { text: '你好' }, { text: '吃饭了吗？' }],
            intervalMs: 10 * MINUTE
        })
    })

    it('rejects shapes the scheduler could not run', () => {
        const invalid = [
            { kind: 'repeat', text: '   ', intervalMs: MINUTE },
            { kind: 'repeat', text: '', intervalMs: MINUTE },
            { kind: 'repeat', text: 'x'.repeat(SESSION_TASK_MAX_TEXT_LENGTH + 1), intervalMs: MINUTE },
            { kind: 'repeat', text: 'ping', intervalMs: MINUTE - 1 },
            { kind: 'repeat', text: 'ping', intervalMs: 30 * 24 * 60 * MINUTE + 1 },
            { kind: 'repeat', text: 'ping', intervalMs: MINUTE, maxRuns: 0 },
            { kind: 'repeat', text: 'ping', intervalMs: MINUTE, maxRuns: 10_001 },
            { kind: 'repeat', text: 'ping', intervalMs: MINUTE, startAt: -1 },
            { kind: 'repeat', text: 'ping', intervalMs: 90_000.5 },
            { kind: 'repeat', text: 'ping' },
            { kind: 'repeat', items: [{ text: 'ping' }], intervalMs: MINUTE },
            { kind: 'repeat', text: 'ping', intervalMs: MINUTE, attachments: [] },
            { kind: 'queue', items: [], intervalMs: MINUTE },
            { kind: 'queue', items: [{ text: 'ok' }, { text: ' ' }], intervalMs: MINUTE },
            { kind: 'queue', items: [{ text: 'ok' }, { text: 'nested', extra: true }], intervalMs: MINUTE },
            { kind: 'queue', text: 'ping', intervalMs: MINUTE },
            { kind: 'queue', items: Array.from({ length: SESSION_TASK_MAX_ITEMS + 1 }, () => ({ text: 'x' })), intervalMs: MINUTE },
            { kind: 'loop', text: 'ping', intervalMs: MINUTE },
            {},
            null
        ]
        for (const body of invalid) {
            expect(CreateSessionTaskRequestSchema.safeParse(body).success).toBe(false)
        }
    })
})

describe('SessionTaskSchema', () => {
    const task = {
        id: 't1',
        sessionId: 's1',
        kind: 'queue',
        state: 'active',
        items: [{ text: 'a' }, { text: 'b' }],
        intervalMs: MINUTE,
        maxRuns: null,
        runCount: 1,
        totalRuns: 2,
        nextRunAt: null,
        pending: true,
        startAt: 1_000,
        lastRunAt: 1_000,
        lastError: null,
        createdAt: 1_000,
        updatedAt: 1_000
    }

    it('round-trips the wire shape', () => {
        expect(SessionTaskSchema.parse(task)).toEqual(task)
    })

    it('rejects an unknown state, error code or field', () => {
        expect(SessionTaskSchema.safeParse({ ...task, state: 'done' }).success).toBe(false)
        expect(SessionTaskSchema.safeParse({ ...task, lastError: 'offline' }).success).toBe(false)
        expect(SessionTaskSchema.safeParse({ ...task, pendingLocalId: 'hapi-task:t1:1' }).success).toBe(false)
    })

    it('requires startAt and accepts every reason a run did not go out', () => {
        const { startAt: _startAt, ...withoutStartAt } = task
        expect(SessionTaskSchema.safeParse(withoutStartAt).success).toBe(false)
        for (const code of SessionTaskErrorCodeSchema.options) {
            expect(SessionTaskSchema.safeParse({ ...task, lastError: code }).success).toBe(true)
        }
    })
})

describe('UpdateSessionTaskRequestSchema', () => {
    it('takes any subset of the editable fields, but at least one', () => {
        expect(UpdateSessionTaskRequestSchema.parse({ paused: true })).toEqual({ paused: true })
        expect(UpdateSessionTaskRequestSchema.parse({ text: 'edited', intervalMs: 2 * MINUTE, maxRuns: null }))
            .toEqual({ text: 'edited', intervalMs: 2 * MINUTE, maxRuns: null })
        expect(UpdateSessionTaskRequestSchema.parse({ items: [{ text: 'a' }, { text: 'b\nsecond line' }] }))
            .toEqual({ items: [{ text: 'a' }, { text: 'b\nsecond line' }] })
        expect(UpdateSessionTaskRequestSchema.safeParse({}).success).toBe(false)
    })

    it('rejects values the create schema rejects too, and unknown fields', () => {
        expect(UpdateSessionTaskRequestSchema.safeParse({ paused: 'true' }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ text: '   ' }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ items: [] }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ intervalMs: 1_000 }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ maxRuns: 0 }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ paused: true, kind: 'queue' }).success).toBe(false)
    })
})

describe('SessionTaskDeleteResponseSchema', () => {
    it('reports what became of a prompt the agent had not taken', () => {
        for (const prompt of ['none', 'cancelled', 'taken', 'unconfirmed']) {
            expect(SessionTaskDeleteResponseSchema.parse({ ok: true, prompt })).toEqual({ ok: true, prompt })
        }
        expect(SessionTaskDeleteResponseSchema.safeParse({ ok: true }).success).toBe(false)
        expect(SessionTaskDeleteResponseSchema.safeParse({ ok: true, prompt: 'deleted' }).success).toBe(false)
    })
})

describe('SessionTaskRunSchema', () => {
    const sent = {
        id: 'r1', sessionId: 's1', taskId: 't1', taskKind: 'repeat', runNumber: 3, outcome: 'sent',
        scheduledFor: 1_000, recordedAt: 1_001, takenAt: 1_004, detail: null, preview: 'check the deploy'
    }

    it('round-trips a sent, taken prompt and a skipped slot', () => {
        expect(SessionTaskRunSchema.parse(sent)).toEqual(sent)
        const skipped = {
            id: 'r2', sessionId: 's1', taskId: 't1', taskKind: 'repeat', runNumber: null, outcome: 'skipped',
            scheduledFor: 61_000, recordedAt: 61_004, takenAt: null, detail: 'previous_prompt_waiting', preview: null
        }
        expect(SessionTaskRunSchema.parse(skipped)).toEqual(skipped)
    })

    it('rejects an unknown outcome, kind or field', () => {
        expect(SessionTaskRunSchema.safeParse({ ...sent, outcome: 'delivered' }).success).toBe(false)
        expect(SessionTaskRunSchema.safeParse({ ...sent, taskKind: 'cron' }).success).toBe(false)
        expect(SessionTaskRunSchema.safeParse({ ...sent, text: 'check the deploy' }).success).toBe(false)
    })

    it('limits the history page a client may ask for', () => {
        expect(SessionTaskRunListQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 })
        expect(SessionTaskRunListQuerySchema.parse({})).toEqual({})
        expect(SessionTaskRunListQuerySchema.safeParse({ limit: 201 }).success).toBe(false)
        expect(SessionTaskRunListQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    })
})

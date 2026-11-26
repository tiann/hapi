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
})

describe('UpdateSessionTaskRequestSchema', () => {
    it('takes exactly one paused flag', () => {
        expect(UpdateSessionTaskRequestSchema.parse({ paused: true })).toEqual({ paused: true })
        expect(UpdateSessionTaskRequestSchema.safeParse({}).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ paused: 'true' }).success).toBe(false)
        expect(UpdateSessionTaskRequestSchema.safeParse({ paused: true, text: 'edited' }).success).toBe(false)
    })
})

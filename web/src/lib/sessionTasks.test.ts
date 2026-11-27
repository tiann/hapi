import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_TASK_MAX_ITEMS, type SessionTask, type SessionTaskRun } from '@hapi/protocol'
import {
    applySessionTaskEdit,
    buildQueueEditRequest,
    buildQueueRequest,
    buildRepeatEditRequest,
    buildRepeatRequest,
    describeIntervalMs,
    EMPTY_QUEUE_DRAFT,
    EMPTY_REPEAT_DRAFT,
    formatTaskInterval,
    formatTaskIntervalCount,
    intervalToMs,
    maxDateTimeLocal,
    minDateTimeLocal,
    queueItems,
    taskErrorText,
    taskRunLabel,
    taskRunOutcome,
    taskStatus,
    taskToDraft,
    type RepeatTaskDraft
} from './sessionTasks'
import { formatScheduledTime } from './scheduledTime'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const t = (key: string, params?: Record<string, string | number>) => {
    const text: Record<string, string> = {
        'composer.taskUnitMinute': 'minute',
        'composer.taskUnitMinutes': '{n} minutes',
        'composer.taskUnitHour': 'hour',
        'composer.taskUnitHours': '{n} hours',
        'composer.taskUnitDay': 'day',
        'composer.taskUnitDays': '{n} days',
        'composer.taskCountOne': '1 {unit}',
        'tasks.paused': 'Paused',
        'tasks.starting': 'Starting…',
        'tasks.dueNow': 'Due now',
        'tasks.waitingForMachine': 'waiting for machine',
        'tasks.sessionUnavailable': 'cannot resume; retrying',
        'tasks.sessionArchived': 'archived',
        'tasks.promptIndeterminate': 'take unknown',
        'tasks.promptNotTaken': 'not taken',
        'tasks.sendFailed': 'send failed',
        'tasks.sentWaiting': 'sent, waiting',
        'tasks.nextRun': 'Next {when}',
        'tasks.nextRunAt': 'Next {when}',
        'tasks.kindQueue': 'Queue',
        'tasks.kindRepeat': 'Repeat',
        'tasks.run.sentWaiting': 'sent, waiting',
        'tasks.run.taken': 'taken',
        'tasks.run.skipped': 'skipped',
        'tasks.run.failed': 'failed',
        'tasks.run.failedWith': 'failed: {reason}',
        'tasks.run.cancelled': 'cancelled',
        'tasks.run.numbered': '{kind} #{n}',
        'session.time.inMinutes': 'in {n}m',
        'session.time.soon': 'soon'
    }
    return (text[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
}

/** A `datetime-local` value `ms` from now. */
function localAt(ms: number): string {
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe('interval helpers', () => {
    it('converts a value and unit to milliseconds', () => {
        expect(intervalToMs(10, 'minutes')).toBe(10 * MINUTE)
        expect(intervalToMs(2, 'hours')).toBe(2 * HOUR)
        expect(intervalToMs(1, 'days')).toBe(24 * HOUR)
    })

    it('describes an interval in the largest whole unit', () => {
        expect(describeIntervalMs(10 * MINUTE)).toEqual({ value: 10, unit: 'minutes' })
        expect(describeIntervalMs(24 * HOUR)).toEqual({ value: 1, unit: 'days' })
        expect(describeIntervalMs(90 * MINUTE)).toEqual({ value: 90, unit: 'minutes' })
    })

    it('uses the singular unit alone after "Every" and the counted form inside a sentence', () => {
        expect(formatTaskInterval(60_000, t)).toBe('minute')
        expect(formatTaskInterval(HOUR, t)).toBe('hour')
        expect(formatTaskInterval(DAY, t)).toBe('day')
        expect(formatTaskInterval(3 * HOUR, t)).toBe('3 hours')
        expect(formatTaskInterval(10 * MINUTE, t)).toBe('10 minutes')
        expect(formatTaskIntervalCount(60_000, t)).toBe('1 minute')
        expect(formatTaskIntervalCount(10 * MINUTE, t)).toBe('10 minutes')
    })
})

describe('queue items', () => {
    it('drops blank rows and keeps a prompt\'s own line breaks', () => {
        expect(queueItems(['first\nsecond line', '  ', '', '你好'])).toEqual(['first\nsecond line', '你好'])
        expect(queueItems([''])).toEqual([])
    })
})

describe('first-run bounds', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('offers a default that stays in the future until the minute after the hub\'s grace', () => {
        // 12:00:45: a minute ahead is 12:01:45, and the default is the next whole minute, 12:02,
        // so a submit at 12:01:05 is not "in the past" any more.
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 45))
        expect(minDateTimeLocal()).toBe('2026-01-15T12:02')
        expect(new Date(`${minDateTimeLocal()}:00`).getTime() - Date.now()).toBeGreaterThanOrEqual(60_000)
        expect(maxDateTimeLocal()).toBe(localAt(Date.now() + 366 * DAY))
    })

    it('is one minute ahead of a time that is already on the minute', () => {
        expect(minDateTimeLocal(new Date(2026, 0, 15, 9, 58).getTime())).toBe('2026-01-15T09:59')
        // Rolls over to the next day.
        expect(minDateTimeLocal(new Date(2026, 0, 15, 23, 59).getTime())).toBe('2026-01-16T00:00')
    })
})

describe('buildRepeatRequest', () => {
    it('uses the composer draft as the message when the form has none', () => {
        const built = buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '30', unit: 'minutes' } }, '  check progress  ')
        expect(built).toEqual({
            request: { kind: 'repeat', text: '  check progress  ', intervalMs: 30 * MINUTE },
            fromComposer: true
        })
    })

    it('prefers the form text once the user types their own', () => {
        const built = buildRepeatRequest(
            { ...EMPTY_REPEAT_DRAFT, text: 'typed in the form', interval: { value: '1', unit: 'hours' }, stopAfterRuns: '5', firstRunAt: localAt(Date.now() + 90 * MINUTE) },
            'composer draft'
        )
        expect('request' in built && built.request).toMatchObject({ kind: 'repeat', text: 'typed in the form', intervalMs: HOUR, maxRuns: 5 })
        expect('fromComposer' in built && built.fromComposer).toBe(false)
        expect('request' in built && typeof built.request.startAt === 'number' && built.request.startAt).toBeGreaterThan(Date.now())
    })

    it('accepts a first run that is seconds in the past, like the hub does, and refuses one beyond its grace', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 30))
        try {
            // The input has minute resolution: 12:00 is 30 s ago, 11:59 is 90 s ago.
            expect('request' in buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: '2026-01-15T12:00' }, 'x')).toBe(true)
            expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: '2026-01-15T11:59' }, 'x')).toEqual({ error: 'firstRun' })
        } finally {
            vi.useRealTimers()
        }
    })

    it('rejects the bounds the hub enforces, each with its own reason', () => {
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '0.5', unit: 'minutes' } }, 'x')).toEqual({ error: 'interval' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '', unit: 'minutes' } }, 'x')).toEqual({ error: 'interval' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '31', unit: 'days' } }, 'x')).toEqual({ error: 'intervalTooLong' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '30', unit: 'days' } }, 'x')).not.toHaveProperty('error')
        expect(buildRepeatRequest(EMPTY_REPEAT_DRAFT, '   ')).toEqual({ error: 'message' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, text: 'x'.repeat(20_001) }, '')).toEqual({ error: 'messageTooLong' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: '2000-01-01T00:00' }, 'x')).toEqual({ error: 'firstRun' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: localAt(Date.now() + 367 * DAY) }, 'x')).toEqual({ error: 'firstRunTooFar' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, stopAfterRuns: '0' }, 'x')).toEqual({ error: 'runs' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, stopAfterRuns: '2.5' }, 'x')).toEqual({ error: 'runs' })
    })

    it('runs now only when no first run was picked, and refuses a set time that is still incomplete', () => {
        // null is the "Now" choice: no start time goes out, for either kind of task.
        const now = buildRepeatRequest(EMPTY_REPEAT_DRAFT, 'x')
        expect('request' in now && 'startAt' in now.request).toBe(false)
        expect('request' in buildQueueRequest(EMPTY_QUEUE_DRAFT, 'first')).toBe(true)
        // '' is a set time with a segment missing, not "now": the form is refused until the date is complete.
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: '' }, 'x')).toEqual({ error: 'firstRun' })
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: ['first'], firstRunAt: '' })).toEqual({ error: 'firstRun' })
    })
})

describe('buildQueueRequest', () => {
    it('keeps each prompt whole, in order, blank rows ignored', () => {
        const built = buildQueueRequest({
            ...EMPTY_QUEUE_DRAFT,
            items: ['first\nwith a second line', '', '你好', '  '],
            interval: { value: '10', unit: 'minutes' }
        })
        expect(built).toEqual({
            request: {
                kind: 'queue',
                items: [{ text: 'first\nwith a second line' }, { text: '你好' }],
                intervalMs: 10 * MINUTE
            },
            fromComposer: false
        })
    })

    it('offers the composer text as the first prompt while nothing is typed', () => {
        const built = buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: [''] }, 'from the composer')
        expect(built).toEqual({
            request: { kind: 'queue', items: [{ text: 'from the composer' }], intervalMs: 10 * MINUTE },
            fromComposer: true
        })
        // Once a prompt is typed, the composer text is left alone.
        const typed = buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: ['typed'] }, 'from the composer')
        expect(typed).toMatchObject({ request: { items: [{ text: 'typed' }] }, fromComposer: false })
    })

    it('refuses an empty list, a too long one, and an over-long prompt', () => {
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: [' ', ''] })).toEqual({ error: 'queue' })
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: [' ', ''] }, '   ')).toEqual({ error: 'queue' })
        expect(buildQueueRequest({
            ...EMPTY_QUEUE_DRAFT,
            items: Array.from({ length: SESSION_TASK_MAX_ITEMS + 1 }, (_, index) => `m${index}`)
        })).toEqual({ error: 'tooMany' })
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, items: ['x'.repeat(20_001)] })).toEqual({ error: 'messageTooLong' })
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, interval: { value: '31', unit: 'days' } })).toEqual({ error: 'intervalTooLong' })
    })
})

const repeatTask: SessionTask = {
    id: 't',
    sessionId: 's',
    kind: 'repeat',
    state: 'active',
    items: [{ text: 'ping' }],
    intervalMs: MINUTE,
    maxRuns: 5,
    runCount: 2,
    totalRuns: 5,
    nextRunAt: 1_000,
    pending: false,
    startAt: 0,
    lastRunAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0
}

const queueTask: SessionTask = {
    ...repeatTask,
    id: 'q',
    kind: 'queue',
    items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    maxRuns: null,
    totalRuns: 3,
    runCount: 1
}

describe('taskToDraft', () => {
    it('fills the editor with the task\'s own fields', () => {
        expect(taskToDraft(repeatTask)).toEqual({ text: 'ping', interval: { value: '1', unit: 'minutes' }, firstRunAt: null, stopAfterRuns: '5' })
        // Only the prompts still to send.
        expect(taskToDraft(queueTask)).toEqual({ items: ['b', 'c'], interval: { value: '1', unit: 'minutes' }, firstRunAt: null })
    })

    it('keeps one blank row for a queue that has sent every prompt', () => {
        // The last prompt is out and still waiting: the task is listed, so its editor needs a row to show.
        expect(taskToDraft({ ...queueTask, runCount: 3, pending: true })).toEqual({ items: [''], interval: { value: '1', unit: 'minutes' }, firstRunAt: null })
    })
})

describe('buildRepeatEditRequest', () => {
    const draft: RepeatTaskDraft = { text: 'pong', interval: { value: '30', unit: 'minutes' }, firstRunAt: null, stopAfterRuns: '5' }

    it('sends only the fields that changed and leaves an untouched run limit alone', () => {
        expect(buildRepeatEditRequest(repeatTask, draft)).toEqual({
            request: { text: 'pong', intervalMs: 30 * MINUTE },
            changed: true
        })
        // A limit expressed in another unit is the same limit.
        expect(buildRepeatEditRequest(
            { ...repeatTask, intervalMs: HOUR },
            { ...draft, text: 'ping', interval: { value: '60', unit: 'minutes' } }
        )).toMatchObject({ request: {}, changed: false })
    })

    it('clears the limit only when the field was emptied, and refuses one below the runs already sent', () => {
        const same: RepeatTaskDraft = { ...draft, text: 'ping', interval: { value: '1', unit: 'minutes' } }
        expect(buildRepeatEditRequest(repeatTask, { ...same, stopAfterRuns: '' })).toEqual({ request: { maxRuns: null }, changed: true })
        expect(buildRepeatEditRequest(repeatTask, { ...same, stopAfterRuns: '1' })).toEqual({ error: 'runsBelowSent' })
        expect(buildRepeatEditRequest(repeatTask, { ...same, stopAfterRuns: '2' })).toEqual({ request: { maxRuns: 2 }, changed: true })
        expect(buildRepeatEditRequest(repeatTask, { ...same, text: '  ' })).toEqual({ error: 'message' })
    })
})

describe('buildQueueEditRequest', () => {
    it('replaces the prompts still to send and keeps the sent ones out of the request', () => {
        const same = { value: '1', unit: 'minutes' } as const
        expect(buildQueueEditRequest(queueTask, { ...EMPTY_QUEUE_DRAFT, items: ['b', 'd', 'e'], interval: same })).toEqual({
            request: { items: [{ text: 'b' }, { text: 'd' }, { text: 'e' }] },
            changed: true
        })
        expect(buildQueueEditRequest(queueTask, { ...EMPTY_QUEUE_DRAFT, items: ['b', '', 'c'], interval: same })).toEqual({ request: {}, changed: false })
        expect(buildQueueEditRequest(queueTask, { ...EMPTY_QUEUE_DRAFT, items: ['b', 'c'], interval: { value: '2', unit: 'hours' } })).toEqual({
            request: { intervalMs: 2 * HOUR },
            changed: true
        })
    })

    it('refuses an empty list', () => {
        expect(buildQueueEditRequest(queueTask, { ...EMPTY_QUEUE_DRAFT, items: [''] })).toEqual({ error: 'queue' })
    })

    it('lets a queue that has sent every prompt change its gap, with nothing typed in the blank row', () => {
        const same = { value: '1', unit: 'minutes' } as const
        const sentOut: SessionTask = { ...queueTask, runCount: 3, pending: true }
        expect(buildQueueEditRequest(sentOut, { ...EMPTY_QUEUE_DRAFT, items: [''], interval: { value: '2', unit: 'hours' } })).toEqual({
            request: { intervalMs: 2 * HOUR },
            changed: true
        })
        // Nothing typed and the same gap: there is nothing to save, but nothing wrong either.
        expect(buildQueueEditRequest(sentOut, { ...EMPTY_QUEUE_DRAFT, items: ['', '  '], interval: same })).toEqual({ request: {}, changed: false })
        // A prompt typed into that row goes after the ones already sent.
        expect(buildQueueEditRequest(sentOut, { ...EMPTY_QUEUE_DRAFT, items: ['d'], interval: same })).toEqual({ request: { items: [{ text: 'd' }] }, changed: true })
    })
})

describe('applySessionTaskEdit', () => {
    it('resumes without the old error and pauses without a next run', () => {
        const paused: SessionTask = { ...repeatTask, state: 'paused', nextRunAt: null, lastError: 'session_unavailable' }
        expect(applySessionTaskEdit(paused, { paused: false })).toMatchObject({ state: 'active', lastError: null })
        expect(applySessionTaskEdit(repeatTask, { paused: true })).toMatchObject({ state: 'paused', nextRunAt: null })
    })

    it('applies the edit the way the hub will', () => {
        const now = 1_000_000
        expect(applySessionTaskEdit(repeatTask, { text: 'pong', maxRuns: 9 }, now)).toMatchObject({ items: [{ text: 'pong' }], maxRuns: 9 })
        expect(applySessionTaskEdit(queueTask, { items: [{ text: 'd' }] }, now)?.items).toEqual([{ text: 'a' }, { text: 'd' }])
        // A new interval re-anchors a task with nothing pending; a waiting prompt keeps its place.
        expect(applySessionTaskEdit(repeatTask, { intervalMs: HOUR }, now)?.nextRunAt).toBe(now + HOUR)
        expect(applySessionTaskEdit({ ...repeatTask, pending: true }, { intervalMs: HOUR }, now)?.nextRunAt).toBe(1_000)
        expect(applySessionTaskEdit({ ...queueTask, state: 'paused', nextRunAt: null }, { intervalMs: HOUR }, now)?.nextRunAt).toBeNull()
    })
})

describe('taskStatus', () => {
    const base: SessionTask = {
        ...repeatTask,
        maxRuns: null,
        totalRuns: null,
        runCount: 0,
        nextRunAt: null
    }

    it('says when an active task runs next, announcing the absolute time rather than the countdown', () => {
        const nextRunAt = Date.now() + 5 * MINUTE
        const status = taskStatus({ ...base, nextRunAt }, t)
        expect(status.tone).toBe('normal')
        expect(status.text).toMatch(/^Next in /)
        expect(status.live).toBe(`Next ${formatScheduledTime(nextRunAt)}`)
    })

    it('has its own sentence for every reason the hub records', () => {
        expect(taskErrorText('machine_offline', t)).toBe('waiting for machine')
        expect(taskErrorText('session_unavailable', t)).toBe('cannot resume; retrying')
        expect(taskErrorText('session_archived', t)).toBe('archived')
        expect(taskErrorText('prompt_indeterminate', t)).toBe('take unknown')
        expect(taskErrorText('prompt_not_taken', t)).toBe('not taken')
        expect(taskErrorText('send_failed', t)).toBe('send failed')
        for (const code of ['machine_offline', 'session_unavailable', 'session_archived', 'prompt_indeterminate', 'prompt_not_taken', 'send_failed'] as const) {
            expect(taskStatus({ ...base, lastError: code }, t)).toEqual({ text: taskErrorText(code, t), tone: 'warning', live: taskErrorText(code, t) })
        }
    })

    it('says a resumed task is starting until the hub reports its next run', () => {
        expect(taskStatus({ ...base, state: 'paused' }, t)).toEqual({ text: 'Paused', tone: 'normal', live: 'Paused' })
        expect(taskStatus({ ...base, lastError: null, nextRunAt: null }, t)).toEqual({ text: 'Starting…', tone: 'normal', live: 'Starting…' })
    })

    it('says a prompt is out while it waits, and that a due run is being sent', () => {
        expect(taskStatus({ ...base, kind: 'queue', pending: true }, t)).toEqual({ text: 'sent, waiting', tone: 'normal', live: 'sent, waiting' })
        expect(taskStatus({ ...base, nextRunAt: Date.now() - MINUTE }, t).text).toBe('Due now')
    })
})

describe('run history lines', () => {
    const run = (overrides: Partial<SessionTaskRun>): SessionTaskRun => ({
        id: 'r1',
        sessionId: 's',
        taskId: 'q',
        taskKind: 'queue',
        runNumber: 2,
        outcome: 'sent',
        scheduledFor: 1_000,
        recordedAt: 1_000,
        takenAt: null,
        detail: null,
        preview: 'second prompt',
        ...overrides
    })

    it('tells a waiting prompt from a taken one', () => {
        expect(taskRunOutcome(run({}), t)).toEqual({ text: 'sent, waiting', tone: 'normal' })
        expect(taskRunOutcome(run({ takenAt: 2_000 }), t)).toEqual({ text: 'taken', tone: 'normal' })
    })

    it('explains skipped and failed runs', () => {
        expect(taskRunOutcome(run({ outcome: 'skipped', detail: 'previous_prompt_waiting', runNumber: null, preview: null }), t)).toEqual({ text: 'skipped', tone: 'normal' })
        expect(taskRunOutcome(run({ outcome: 'failed', detail: 'machine_offline', runNumber: null }), t)).toEqual({ text: 'failed: waiting for machine', tone: 'warning' })
        expect(taskRunOutcome(run({ outcome: 'failed', detail: null, runNumber: null }), t)).toEqual({ text: 'failed', tone: 'warning' })
        expect(taskRunOutcome(run({ outcome: 'cancelled' }), t)).toEqual({ text: 'cancelled', tone: 'normal' })
    })

    it('numbers a queue run and names a repeat task', () => {
        expect(taskRunLabel(run({}), t)).toBe('Queue #2')
        expect(taskRunLabel(run({ taskKind: 'repeat' }), t)).toBe('Repeat')
    })
})

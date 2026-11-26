import { describe, expect, it } from 'vitest'
import type { SessionTask } from '@hapi/protocol'
import {
    buildQueueRequest,
    buildRepeatRequest,
    describeIntervalMs,
    EMPTY_QUEUE_DRAFT,
    EMPTY_REPEAT_DRAFT,
    formatTaskInterval,
    intervalToMs,
    minDateTimeLocal,
    parseQueuePrompts,
    SESSION_TASK_MAX_PROMPTS,
    taskStatus
} from './sessionTasks'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const t = (key: string, params?: Record<string, string | number>) => {
    const text: Record<string, string> = {
        'composer.taskUnitMinutes': 'minutes',
        'composer.taskUnitHours': 'hours',
        'composer.taskUnitDays': 'days',
        'tasks.paused': 'Paused',
        'tasks.waitingForMachine': 'waiting for machine',
        'tasks.sessionUnavailable': 'session unavailable',
        'tasks.sendFailed': 'send failed',
        'tasks.sentWaiting': 'sent, waiting',
        'tasks.nextRun': 'Next {when}',
        'session.time.inMinutes': 'in {n}m',
        'session.time.soon': 'soon'
    }
    return (text[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
}

/** A `datetime-local` value `minutesAhead` from now. */
function futureLocal(minutesAhead: number): string {
    const date = new Date(Date.now() + minutesAhead * MINUTE)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe('parseQueuePrompts', () => {
    it('takes one prompt per non-empty line and drops blank lines', () => {
        expect(parseQueuePrompts('first\n\n你好\r\n  吃饭了吗？  \n')).toEqual(['first', '你好', '吃饭了吗？'])
        expect(parseQueuePrompts('')).toEqual([])
        expect(parseQueuePrompts('  \n \n')).toEqual([])
    })
})

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
        expect(formatTaskInterval(3 * HOUR, t)).toBe('3 hours')
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
            { ...EMPTY_REPEAT_DRAFT, text: 'typed in the form', interval: { value: '1', unit: 'hours' }, stopAfterRuns: '5', firstRunAt: futureLocal(90) },
            'composer draft'
        )
        expect('request' in built && built.request).toMatchObject({ kind: 'repeat', text: 'typed in the form', intervalMs: HOUR, maxRuns: 5 })
        expect('fromComposer' in built && built.fromComposer).toBe(false)
        expect('request' in built && typeof built.request.startAt === 'number' && built.request.startAt).toBeGreaterThan(Date.now())
    })

    it('rejects an interval under a minute, a blank message, a past first run and a bad run count', () => {
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '0.5', unit: 'minutes' } }, 'x')).toEqual({ error: 'interval' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, interval: { value: '', unit: 'minutes' } }, 'x')).toEqual({ error: 'interval' })
        expect(buildRepeatRequest(EMPTY_REPEAT_DRAFT, '   ')).toEqual({ error: 'message' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, firstRunAt: '2000-01-01T00:00' }, 'x')).toEqual({ error: 'firstRun' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, stopAfterRuns: '0' }, 'x')).toEqual({ error: 'runs' })
        expect(buildRepeatRequest({ ...EMPTY_REPEAT_DRAFT, stopAfterRuns: '2.5' }, 'x')).toEqual({ error: 'runs' })
    })
})

describe('buildQueueRequest', () => {
    it('splits the textarea into ordered prompts', () => {
        const built = buildQueueRequest({
            ...EMPTY_QUEUE_DRAFT,
            prompts: 'first\n你好\n吃饭了吗？',
            interval: { value: '10', unit: 'minutes' }
        })
        expect(built).toEqual({
            request: {
                kind: 'queue',
                items: [{ text: 'first' }, { text: '你好' }, { text: '吃饭了吗？' }],
                intervalMs: 10 * MINUTE
            }
        })
    })

    it('rejects an empty queue and one that is too long', () => {
        expect(buildQueueRequest({ ...EMPTY_QUEUE_DRAFT, prompts: ' \n ' })).toEqual({ error: 'queue' })
        expect(buildQueueRequest({
            ...EMPTY_QUEUE_DRAFT,
            prompts: Array.from({ length: SESSION_TASK_MAX_PROMPTS + 1 }, (_, index) => `m${index}`).join('\n')
        })).toEqual({ error: 'tooMany' })
    })
})

describe('minDateTimeLocal', () => {
    it('is one minute ahead of the given time', () => {
        expect(minDateTimeLocal(new Date(2026, 0, 15, 9, 58).getTime())).toBe('2026-01-15T09:59')
        // Rolls over to the next day.
        expect(minDateTimeLocal(new Date(2026, 0, 15, 23, 59).getTime())).toBe('2026-01-16T00:00')
    })
})

describe('taskStatus', () => {
    const base: SessionTask = {
        id: 't',
        sessionId: 's',
        kind: 'repeat',
        state: 'active',
        items: [{ text: 'ping' }],
        intervalMs: MINUTE,
        maxRuns: null,
        runCount: 0,
        totalRuns: null,
        nextRunAt: null,
        pending: false,
        lastRunAt: null,
        lastError: null,
        createdAt: 0,
        updatedAt: 0
    }

    it('says when an active task runs next', () => {
        const nextRunAt = Date.now() + 5 * MINUTE
        const status = taskStatus({ ...base, nextRunAt }, t)
        expect(status.tone).toBe('normal')
        expect(status.text).toMatch(/^Next in /)
    })

    it('explains what holds a task up', () => {
        expect(taskStatus({ ...base, lastError: 'machine_offline' }, t)).toEqual({ text: 'waiting for machine', tone: 'warning' })
        expect(taskStatus({ ...base, lastError: 'send_failed' }, t)).toEqual({ text: 'send failed', tone: 'warning' })
        expect(taskStatus({ ...base, state: 'paused' }, t)).toEqual({ text: 'Paused', tone: 'normal' })
        expect(taskStatus({ ...base, state: 'paused', lastError: 'session_unavailable' }, t)).toEqual({ text: 'session unavailable', tone: 'warning' })
    })

    it('says a queue prompt was sent while it waits for the agent', () => {
        expect(taskStatus({ ...base, kind: 'queue', pending: true }, t)).toEqual({ text: 'sent, waiting', tone: 'normal' })
    })
})

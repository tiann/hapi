import {
    checkSessionTaskStartAt,
    SESSION_TASK_MAX_INTERVAL_MS,
    SESSION_TASK_MAX_ITEMS,
    SESSION_TASK_MAX_RUNS,
    SESSION_TASK_MAX_START_OFFSET_MS,
    SESSION_TASK_MAX_TEXT_LENGTH,
    SESSION_TASK_MIN_INTERVAL_MS,
    type CreateSessionTaskRequest,
    type SessionTask,
    type SessionTaskErrorCode,
    type SessionTaskRun,
    type UpdateSessionTaskRequest
} from '@hapi/protocol'
import { formatFutureRelativeTime, formatScheduledTime } from '@/lib/scheduledTime'

type Translate = (key: string, params?: Record<string, string | number>) => string

export const SESSION_TASK_INTERVAL_UNITS = ['minutes', 'hours', 'days'] as const
export type SessionTaskIntervalUnit = (typeof SESSION_TASK_INTERVAL_UNITS)[number]

const UNIT_MS: Record<SessionTaskIntervalUnit, number> = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000
}

/** The interval as a phrase: `minute` alone when the value is 1, else `{n} minutes`. */
const UNIT_PHRASE_KEY: Record<SessionTaskIntervalUnit, { one: string; other: string }> = {
    minutes: { one: 'composer.taskUnitMinute', other: 'composer.taskUnitMinutes' },
    hours: { one: 'composer.taskUnitHour', other: 'composer.taskUnitHours' },
    days: { one: 'composer.taskUnitDay', other: 'composer.taskUnitDays' }
}

export type IntervalInput = { value: string; unit: SessionTaskIntervalUnit }

export type TaskDraftError =
    | 'interval'
    | 'intervalTooLong'
    | 'message'
    | 'messageTooLong'
    | 'queue'
    | 'tooMany'
    | 'firstRun'
    | 'firstRunTooFar'
    | 'runs'
    | 'runsBelowSent'

export type RepeatTaskDraft = {
    text: string
    interval: IntervalInput
    /** null runs now; a `datetime-local` value runs at that time, '' while that value is still incomplete. */
    firstRunAt: string | null
    /** '' repeats until the task is paused or deleted. */
    stopAfterRuns: string
}

export type QueueTaskDraft = {
    /** One prompt per entry; each may span several lines. */
    items: string[]
    interval: IntervalInput
    firstRunAt: string | null
}

export const EMPTY_INTERVAL: IntervalInput = { value: '10', unit: 'minutes' }

export const EMPTY_REPEAT_DRAFT: RepeatTaskDraft = { text: '', interval: EMPTY_INTERVAL, firstRunAt: null, stopAfterRuns: '' }
/** One blank row: the queue editor always shows at least one prompt field. */
export const EMPTY_QUEUE_DRAFT: QueueTaskDraft = { items: [''], interval: EMPTY_INTERVAL, firstRunAt: null }

export function intervalToMs(value: number, unit: SessionTaskIntervalUnit): number {
    return Math.round(value * UNIT_MS[unit])
}

/** The largest unit in which the interval is a whole number. */
export function describeIntervalMs(ms: number): { value: number; unit: SessionTaskIntervalUnit } {
    for (const unit of ['days', 'hours'] as const) {
        if (ms % UNIT_MS[unit] === 0) return { value: ms / UNIT_MS[unit], unit }
    }
    return { value: ms / UNIT_MS.minutes, unit: 'minutes' }
}

/** "10 minutes" / "1 minute" / "10 分钟": the interval with its count, for use inside a sentence. */
export function formatTaskIntervalCount(ms: number, t: Translate): string {
    const { value, unit } = describeIntervalMs(ms)
    return value === 1 ? t('composer.taskCountOne', { unit: t(UNIT_PHRASE_KEY[unit].one) }) : t(UNIT_PHRASE_KEY[unit].other, { n: value })
}

/** "Every {interval}": `minute` alone when the interval is one unit, else the counted form. */
export function formatTaskInterval(ms: number, t: Translate): string {
    const { value, unit } = describeIntervalMs(ms)
    return value === 1 ? t(UNIT_PHRASE_KEY[unit].one) : t(UNIT_PHRASE_KEY[unit].other, { n: value })
}

/** The queue editor's prompts without its blank rows. */
export function queueItems(items: string[]): string[] {
    return items.filter((item) => item.trim().length > 0)
}

/** The interval as typed, in ms; null while the field is not a positive number. */
export function readIntervalMs(interval: IntervalInput): number | null {
    const value = Number(interval.value)
    if (!interval.value.trim() || !Number.isFinite(value) || value <= 0) return null
    return intervalToMs(value, interval.unit)
}

function readInterval(interval: IntervalInput): number | 'short' | 'long' | 'invalid' {
    const ms = readIntervalMs(interval)
    if (ms === null) return 'invalid'
    if (ms < SESSION_TASK_MIN_INTERVAL_MS) return 'short'
    if (ms > SESSION_TASK_MAX_INTERVAL_MS) return 'long'
    return ms
}

function readFirstRun(firstRunAt: string | null, now: number = Date.now()): { startAt?: number } | { error: TaskDraftError } {
    if (firstRunAt === null) return {}
    // '' is a set time with a segment missing: the browser reports no value until the date is complete.
    const ms = new Date(firstRunAt).getTime()
    // The hub tolerates a first run up to a minute in the past (clock skew, a slow request); see
    // checkSessionTaskStartAt. Anything older, or beyond the horizon, is refused here first.
    const issue = Number.isFinite(ms) ? checkSessionTaskStartAt(ms, now) : 'past'
    if (issue === 'past') return { error: 'firstRun' }
    if (issue === 'too-far') return { error: 'firstRunTooFar' }
    return { startAt: ms }
}

function readRuns(raw: string): number | null | 'invalid' {
    if (!raw.trim()) return null
    const runs = Number(raw)
    if (!Number.isInteger(runs) || runs < 1 || runs > SESSION_TASK_MAX_RUNS) return 'invalid'
    return runs
}

function checkMessageLength(text: string): TaskDraftError | null {
    return text.length > SESSION_TASK_MAX_TEXT_LENGTH ? 'messageTooLong' : null
}

function toDateTimeLocal(ms: number): string {
    const date = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The earliest `datetime-local` value the form offers: the first whole minute
 * that is still at least a minute ahead, so the default does not expire while
 * the user reviews the form.
 */
export function minDateTimeLocal(now: number = Date.now()): string {
    return toDateTimeLocal(Math.ceil((now + SESSION_TASK_MIN_INTERVAL_MS) / 60_000) * 60_000)
}

/** The latest `datetime-local` value the hub accepts for a first run. */
export function maxDateTimeLocal(now: number = Date.now()): string {
    return toDateTimeLocal(now + SESSION_TASK_MAX_START_OFFSET_MS)
}

/** `message` is what the form shows: its own text, or the composer draft it was prefilled from. */
export function repeatDraftMessage(draft: RepeatTaskDraft, composerDraft: string): string {
    return draft.text || composerDraft
}

/**
 * The editor offers the composer's text as the first prompt while the first
 * row is blank, whatever the other rows hold; it is then the text to clear
 * from the composer once the task exists.
 */
export function queueUsesComposer(draft: QueueTaskDraft, composerDraft: string): boolean {
    return composerDraft.trim().length > 0 && !draft.items[0]?.trim()
}

/** The prompts a queue sends: its typed rows, with the composer's text standing in for a blank first row. */
export function queueDraftItems(draft: QueueTaskDraft, composerDraft: string): string[] {
    const items = draft.items.slice()
    if (queueUsesComposer(draft, composerDraft)) items[0] = composerDraft
    return queueItems(items)
}

export function buildRepeatRequest(
    draft: RepeatTaskDraft,
    composerDraft: string
): { request: CreateSessionTaskRequest; fromComposer: boolean } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === 'short') return { error: 'interval' }
    if (intervalMs === 'long') return { error: 'intervalTooLong' }
    if (typeof intervalMs !== 'number') return { error: 'interval' }
    const message = repeatDraftMessage(draft, composerDraft)
    if (!message.trim()) return { error: 'message' }
    if (message.length > SESSION_TASK_MAX_TEXT_LENGTH) return { error: 'messageTooLong' }
    const firstRun = readFirstRun(draft.firstRunAt)
    if ('error' in firstRun) return firstRun
    const maxRuns = readRuns(draft.stopAfterRuns)
    if (maxRuns === 'invalid') return { error: 'runs' }
    return {
        request: {
            kind: 'repeat',
            text: message,
            intervalMs,
            ...(firstRun.startAt !== undefined ? { startAt: firstRun.startAt } : {}),
            ...(maxRuns !== null ? { maxRuns } : {})
        },
        fromComposer: draft.text === '' && composerDraft.trim().length > 0
    }
}

export function buildQueueRequest(
    draft: QueueTaskDraft,
    composerDraft: string = ''
): { request: CreateSessionTaskRequest; fromComposer: boolean } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === 'short') return { error: 'interval' }
    if (intervalMs === 'long') return { error: 'intervalTooLong' }
    if (typeof intervalMs !== 'number') return { error: 'interval' }
    const prompts = queueDraftItems(draft, composerDraft)
    if (prompts.length === 0) return { error: 'queue' }
    if (prompts.length > SESSION_TASK_MAX_ITEMS) return { error: 'tooMany' }
    if (prompts.some((text) => text.length > SESSION_TASK_MAX_TEXT_LENGTH)) return { error: 'messageTooLong' }
    const firstRun = readFirstRun(draft.firstRunAt)
    if ('error' in firstRun) return firstRun
    return {
        request: {
            kind: 'queue',
            items: prompts.map((text) => ({ text })),
            intervalMs,
            ...(firstRun.startAt !== undefined ? { startAt: firstRun.startAt } : {})
        },
        fromComposer: queueUsesComposer(draft, composerDraft)
    }
}

/** The form fields of an existing task, for the inline editor under its row. The editor does not offer a first run. */
export function taskToDraft(task: SessionTask): RepeatTaskDraft | QueueTaskDraft {
    const described = describeIntervalMs(task.intervalMs)
    const interval: IntervalInput = { value: String(described.value), unit: described.unit }
    if (task.kind === 'queue') {
        // Only the prompts still to send can change; the ones already sent stay as they are.
        return { items: task.items.slice(task.runCount).map((item) => item.text), interval, firstRunAt: null }
    }
    return {
        text: task.items[0]?.text ?? '',
        interval,
        firstRunAt: null,
        stopAfterRuns: task.maxRuns === null ? '' : String(task.maxRuns)
    }
}

/**
 * Changes to a repeat task: only the fields that differ from the task, so an
 * untouched run limit is not cleared. `changed` is false when nothing differs.
 */
export function buildRepeatEditRequest(
    task: SessionTask,
    draft: RepeatTaskDraft
): { request: UpdateSessionTaskRequest; changed: boolean } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === 'short') return { error: 'interval' }
    if (intervalMs === 'long') return { error: 'intervalTooLong' }
    if (typeof intervalMs !== 'number') return { error: 'interval' }
    if (!draft.text.trim()) return { error: 'message' }
    if (draft.text.length > SESSION_TASK_MAX_TEXT_LENGTH) return { error: 'messageTooLong' }
    const maxRuns = readRuns(draft.stopAfterRuns)
    if (maxRuns === 'invalid') return { error: 'runs' }
    if (maxRuns !== null && maxRuns < task.runCount) return { error: 'runsBelowSent' }
    const request: UpdateSessionTaskRequest = {}
    if (draft.text !== task.items[0]?.text) request.text = draft.text
    if (intervalMs !== task.intervalMs) request.intervalMs = intervalMs
    if (maxRuns !== task.maxRuns) request.maxRuns = maxRuns
    return { request, changed: Object.keys(request).length > 0 }
}

/** Changes to a queue: the prompts still to send, and the gap between them. */
export function buildQueueEditRequest(
    task: SessionTask,
    draft: QueueTaskDraft
): { request: UpdateSessionTaskRequest; changed: boolean } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === 'short') return { error: 'interval' }
    if (intervalMs === 'long') return { error: 'intervalTooLong' }
    if (typeof intervalMs !== 'number') return { error: 'interval' }
    const prompts = queueItems(draft.items)
    if (prompts.length === 0) return { error: 'queue' }
    if (prompts.length > SESSION_TASK_MAX_ITEMS) return { error: 'tooMany' }
    if (prompts.some((text) => text.length > SESSION_TASK_MAX_TEXT_LENGTH)) return { error: 'messageTooLong' }
    const request: UpdateSessionTaskRequest = {}
    const current = task.items.slice(task.runCount).map((item) => item.text)
    if (current.length !== prompts.length || current.some((text, index) => text !== prompts[index])) {
        request.items = prompts.map((text) => ({ text }))
    }
    if (intervalMs !== task.intervalMs) request.intervalMs = intervalMs
    return { request, changed: Object.keys(request).length > 0 }
}

/** Applies an edit to the task as the hub will, so the row updates before the answer arrives. */
export function applySessionTaskEdit(task: SessionTask, request: UpdateSessionTaskRequest, now: number = Date.now()): SessionTask {
    let next = task
    if (request.paused !== undefined) {
        next = {
            ...next,
            state: request.paused ? 'paused' : 'active',
            // The hub has no next run to show while the task is paused; a resumed one reports it.
            nextRunAt: request.paused ? null : next.nextRunAt,
            lastError: request.paused ? next.lastError : null
        }
    }
    if (request.text !== undefined && next.kind === 'repeat') {
        next = { ...next, items: [{ text: request.text }] }
    }
    if (request.items !== undefined && next.kind === 'queue') {
        next = { ...next, items: [...next.items.slice(0, next.runCount), ...request.items] }
    }
    if (request.intervalMs !== undefined) {
        // A new interval re-anchors an active task with nothing pending to now + interval.
        next = {
            ...next,
            intervalMs: request.intervalMs,
            nextRunAt: next.state === 'active' && !next.pending && next.runCount > 0
                ? now + request.intervalMs
                : next.nextRunAt
        }
    }
    if (request.maxRuns !== undefined) {
        next = { ...next, maxRuns: request.maxRuns }
    }
    return next
}

export type TaskStatus = { text: string; tone: 'normal' | 'warning'; /** What a screen reader hears; changes only on a state change. */ live: string }

/** One line under a task: when it runs next, or what is holding it up. */
export function taskStatus(task: SessionTask, t: Translate, now: number = Date.now()): TaskStatus {
    if (task.state === 'paused') return { text: t('tasks.paused'), tone: 'normal', live: t('tasks.paused') }
    if (task.lastError) {
        const text = taskErrorText(task.lastError, t)
        return { text, tone: 'warning', live: text }
    }
    if (task.pending) {
        const text = t('tasks.sentWaiting')
        return { text, tone: 'normal', live: text }
    }
    if (task.nextRunAt === null) {
        const text = t('tasks.starting')
        return { text, tone: 'normal', live: text }
    }
    if (task.nextRunAt <= now) {
        const text = t('tasks.dueNow')
        return { text, tone: 'normal', live: text }
    }
    // The countdown changes every minute; the absolute time is what gets announced.
    const relative = formatFutureRelativeTime(task.nextRunAt, t)
    const live = t('tasks.nextRunAt', { when: formatScheduledTime(task.nextRunAt) })
    return relative
        ? { text: t('tasks.nextRun', { when: relative }), tone: 'normal', live }
        : { text: live, tone: 'normal', live }
}

/** A sentence for every reason the hub records on a task. */
export function taskErrorText(code: SessionTaskErrorCode, t: Translate): string {
    switch (code) {
        case 'machine_offline':
            return t('tasks.waitingForMachine')
        case 'session_unavailable':
            return t('tasks.sessionUnavailable')
        case 'session_archived':
            return t('tasks.sessionArchived')
        case 'prompt_indeterminate':
            return t('tasks.promptIndeterminate')
        case 'prompt_not_taken':
            return t('tasks.promptNotTaken')
        case 'send_failed':
            return t('tasks.sendFailed')
    }
}

export type TaskRunOutcome = { text: string; tone: 'normal' | 'warning' }

/** What became of one run: sent (and taken or waiting), skipped, failed or cancelled, and why. */
export function taskRunOutcome(run: SessionTaskRun, t: Translate): TaskRunOutcome {
    switch (run.outcome) {
        case 'sent':
            if (run.takenAt === null) {
                const text = t('tasks.run.sentWaiting')
                return { text, tone: 'normal' }
            }
            return { text: t('tasks.run.taken'), tone: 'normal' }
        case 'skipped':
            return { text: t('tasks.run.skipped'), tone: 'normal' }
        case 'failed': {
            const text = run.detail && isTaskErrorCode(run.detail)
                ? t('tasks.run.failedWith', { reason: taskErrorText(run.detail, t) })
                : t('tasks.run.failed')
            return { text, tone: 'warning' }
        }
        case 'cancelled':
            return { text: t('tasks.run.cancelled'), tone: 'normal' }
    }
}

const TASK_ERROR_CODES: readonly SessionTaskErrorCode[] = [
    'machine_offline',
    'session_unavailable',
    'session_archived',
    'prompt_indeterminate',
    'prompt_not_taken',
    'send_failed'
]

function isTaskErrorCode(value: string): value is SessionTaskErrorCode {
    return (TASK_ERROR_CODES as readonly string[]).includes(value)
}

/** `#3` for a queue's run, or the kind for a repeat task's. */
export function taskRunLabel(run: SessionTaskRun, t: Translate): string {
    return run.runNumber !== null && run.taskKind === 'queue'
        ? t('tasks.run.numbered', { kind: t('tasks.kindQueue'), n: run.runNumber })
        : t(run.taskKind === 'queue' ? 'tasks.kindQueue' : 'tasks.kindRepeat')
}

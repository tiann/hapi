import type { CreateSessionTaskRequest, SessionTask } from '@hapi/protocol'
import { formatScheduledFireLabel } from '@/lib/scheduledTime'

type Translate = (key: string, params?: Record<string, string | number>) => string

export const SESSION_TASK_INTERVAL_UNITS = ['minutes', 'hours', 'days'] as const
export type SessionTaskIntervalUnit = (typeof SESSION_TASK_INTERVAL_UNITS)[number]

const UNIT_MS: Record<SessionTaskIntervalUnit, number> = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000
}

const UNIT_LABEL_KEY: Record<SessionTaskIntervalUnit, string> = {
    minutes: 'composer.taskUnitMinutes',
    hours: 'composer.taskUnitHours',
    days: 'composer.taskUnitDays'
}

export type IntervalInput = { value: string; unit: SessionTaskIntervalUnit }

export type TaskDraftError = 'interval' | 'message' | 'queue' | 'tooMany' | 'firstRun' | 'runs'

export type RepeatTaskDraft = {
    text: string
    interval: IntervalInput
    /** '' runs now, a `datetime-local` value runs at that time. */
    firstRunAt: string
    /** '' repeats until the task is paused or deleted. */
    stopAfterRuns: string
}

export type QueueTaskDraft = {
    /** One prompt per line. */
    prompts: string
    interval: IntervalInput
    firstRunAt: string
}

export const EMPTY_INTERVAL: IntervalInput = { value: '10', unit: 'minutes' }

export const EMPTY_REPEAT_DRAFT: RepeatTaskDraft = { text: '', interval: EMPTY_INTERVAL, firstRunAt: '', stopAfterRuns: '' }
export const EMPTY_QUEUE_DRAFT: QueueTaskDraft = { prompts: '', interval: EMPTY_INTERVAL, firstRunAt: '' }

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

/** "10 minutes" / "10 分钟" */
export function formatTaskInterval(ms: number, t: Translate): string {
    const { value, unit } = describeIntervalMs(ms)
    return `${value} ${t(UNIT_LABEL_KEY[unit])}`
}

/** A queue textarea holds one prompt per non-empty line. */
export function parseQueuePrompts(text: string): string[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

export const SESSION_TASK_MIN_INTERVAL_MS = 60_000
export const SESSION_TASK_MAX_PROMPTS = 50
export const SESSION_TASK_MAX_RUNS = 10_000

function readInterval(interval: IntervalInput): number | null {
    const value = Number(interval.value)
    if (!interval.value.trim() || !Number.isFinite(value) || value <= 0) return null
    return intervalToMs(value, interval.unit)
}

function readFirstRun(firstRunAt: string): { startAt?: number } | { error: 'firstRun' } {
    if (!firstRunAt) return {}
    const ms = new Date(firstRunAt).getTime()
    if (!Number.isFinite(ms) || ms <= Date.now()) return { error: 'firstRun' }
    return { startAt: ms }
}

function readRuns(raw: string): number | null | 'invalid' {
    if (!raw.trim()) return null
    const runs = Number(raw)
    if (!Number.isInteger(runs) || runs < 1 || runs > SESSION_TASK_MAX_RUNS) return 'invalid'
    return runs
}

/** `message` is what the form shows: its own text, or the composer draft it was prefilled from. */
export function repeatDraftMessage(draft: RepeatTaskDraft, composerDraft: string): string {
    return draft.text || composerDraft
}

export function buildRepeatRequest(
    draft: RepeatTaskDraft,
    composerDraft: string
): { request: CreateSessionTaskRequest; fromComposer: boolean } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === null || intervalMs < SESSION_TASK_MIN_INTERVAL_MS) return { error: 'interval' }
    const message = repeatDraftMessage(draft, composerDraft)
    if (!message.trim()) return { error: 'message' }
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

export function buildQueueRequest(draft: QueueTaskDraft): { request: CreateSessionTaskRequest } | { error: TaskDraftError } {
    const intervalMs = readInterval(draft.interval)
    if (intervalMs === null || intervalMs < SESSION_TASK_MIN_INTERVAL_MS) return { error: 'interval' }
    const prompts = parseQueuePrompts(draft.prompts)
    if (prompts.length === 0) return { error: 'queue' }
    if (prompts.length > SESSION_TASK_MAX_PROMPTS) return { error: 'tooMany' }
    const firstRun = readFirstRun(draft.firstRunAt)
    if ('error' in firstRun) return firstRun
    return {
        request: {
            kind: 'queue',
            items: prompts.map((text) => ({ text })),
            intervalMs,
            ...(firstRun.startAt !== undefined ? { startAt: firstRun.startAt } : {})
        }
    }
}

/** The latest `datetime-local` value that is still in the future (one minute ahead). */
export function minDateTimeLocal(now: number = Date.now()): string {
    const date = new Date(now + 60_000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export type TaskStatus = { text: string; tone: 'normal' | 'warning' }

/** One line under a task: when it runs next, or what is holding it up. */
export function taskStatus(task: SessionTask, t: Translate): TaskStatus {
    if (task.state === 'paused') {
        return task.lastError === 'session_unavailable'
            ? { text: t('tasks.sessionUnavailable'), tone: 'warning' }
            : { text: t('tasks.paused'), tone: 'normal' }
    }
    if (task.lastError === 'machine_offline') return { text: t('tasks.waitingForMachine'), tone: 'warning' }
    if (task.lastError === 'send_failed') return { text: t('tasks.sendFailed'), tone: 'warning' }
    if (task.lastError === 'session_unavailable') return { text: t('tasks.sessionUnavailable'), tone: 'warning' }
    if (task.nextRunAt !== null) {
        const when = formatScheduledFireLabel(task.nextRunAt, t)
        return when
            ? { text: t('tasks.nextRun', { when }), tone: 'normal' }
            : { text: t('tasks.sentWaiting'), tone: 'normal' }
    }
    return { text: t('tasks.sentWaiting'), tone: 'normal' }
}

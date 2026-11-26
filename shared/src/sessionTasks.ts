import { z } from 'zod'

/**
 * Session tasks: prompts the hub sends into a session on its own schedule.
 *
 * A one-shot scheduled message is a `scheduledAt` row on the messages table
 * (see SendMessageRequestSchema). A task covers what that row cannot express:
 *
 * - `repeat` — the same prompt every `intervalMs`, until paused or deleted.
 * - `queue`  — a list of prompts sent one at a time, each `intervalMs` after
 *              the agent took the previous one.
 *
 * The hub owns the schedule. A task inserts an ordinary user message each
 * time it runs, and resumes the session first if it is not running.
 */

/** localId prefix of the messages a task inserts (`hapi-task:<taskId>:<n>`). */
export const SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX = 'hapi-task:'

export const SESSION_TASK_MIN_INTERVAL_MS = 60 * 1000
export const SESSION_TASK_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
export const SESSION_TASK_MAX_ITEMS = 50
export const SESSION_TASK_MAX_TEXT_LENGTH = 20_000
export const SESSION_TASK_MAX_RUNS = 10_000
/** How far ahead a task's first run may be. */
export const SESSION_TASK_MAX_START_OFFSET_MS = 366 * 24 * 60 * 60 * 1000
/** Tolerance for a first-run time that is already in the past (clock skew, slow request). */
export const SESSION_TASK_START_GRACE_MS = 60 * 1000

export const SessionTaskKindSchema = z.enum(['repeat', 'queue'])
export type SessionTaskKind = z.infer<typeof SessionTaskKindSchema>

export const SessionTaskStateSchema = z.enum(['active', 'paused'])
export type SessionTaskState = z.infer<typeof SessionTaskStateSchema>

/**
 * Why the last run did not go out. `machine_offline` and `send_failed` clear
 * on the next successful run; `session_unavailable` also pauses the task.
 */
export const SessionTaskErrorCodeSchema = z.enum([
    'machine_offline',
    'session_unavailable',
    'send_failed'
])
export type SessionTaskErrorCode = z.infer<typeof SessionTaskErrorCodeSchema>

const TaskTextSchema = z.string()
    .max(SESSION_TASK_MAX_TEXT_LENGTH)
    .refine((text) => text.trim().length > 0, { message: 'text must not be blank' })

const IntervalMsSchema = z.number()
    .int()
    .min(SESSION_TASK_MIN_INTERVAL_MS)
    .max(SESSION_TASK_MAX_INTERVAL_MS)

export const SessionTaskSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    kind: SessionTaskKindSchema,
    state: SessionTaskStateSchema,
    /** `repeat`: exactly one entry. `queue`: the prompts in sending order. */
    items: z.array(z.object({ text: z.string() }).strict()),
    intervalMs: z.number().int().positive(),
    /** `repeat`: stop after this many sends. `queue`: null (the item list bounds it). */
    maxRuns: z.number().int().positive().nullable(),
    /** Prompts sent so far. */
    runCount: z.number().int().nonnegative(),
    /** Total sends when the task ends on its own, else null. */
    totalRuns: z.number().int().positive().nullable(),
    /** When the next prompt goes out. null while paused, or while a `queue` task waits for its last prompt to be taken. */
    nextRunAt: z.number().nullable(),
    /** A prompt this task sent has not been taken by the agent yet. */
    pending: z.boolean(),
    lastRunAt: z.number().nullable(),
    lastError: SessionTaskErrorCodeSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number()
}).strict()

export type SessionTask = z.infer<typeof SessionTaskSchema>

export const CreateSessionTaskRequestSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('repeat'),
        text: TaskTextSchema,
        intervalMs: IntervalMsSchema,
        /** First run. Defaults to now. */
        startAt: z.number().int().positive().optional(),
        maxRuns: z.number().int().min(1).max(SESSION_TASK_MAX_RUNS).optional()
    }).strict(),
    z.object({
        kind: z.literal('queue'),
        items: z.array(z.object({ text: TaskTextSchema }).strict())
            .min(1)
            .max(SESSION_TASK_MAX_ITEMS),
        intervalMs: IntervalMsSchema,
        /** When the first prompt goes out. Defaults to now. */
        startAt: z.number().int().positive().optional()
    }).strict()
])

export type CreateSessionTaskRequest = z.infer<typeof CreateSessionTaskRequestSchema>

export const UpdateSessionTaskRequestSchema = z.object({
    paused: z.boolean()
}).strict()

export type UpdateSessionTaskRequest = z.infer<typeof UpdateSessionTaskRequestSchema>

export type SessionTaskResponse = { task: SessionTask }
export type SessionTaskListResponse = { tasks: SessionTask[] }

export type SessionTaskStartAtIssue = 'past' | 'too-far'

/** Range check for a task's first run. Null when `startAt` is acceptable. */
export function checkSessionTaskStartAt(startAt: number, now: number): SessionTaskStartAtIssue | null {
    if (startAt < now - SESSION_TASK_START_GRACE_MS) return 'past'
    if (startAt > now + SESSION_TASK_MAX_START_OFFSET_MS) return 'too-far'
    return null
}

/** localId of the message a task inserts for its `runNumber`-th send (1-based). */
export function buildSessionTaskMessageLocalId(taskId: string, runNumber: number): string {
    return `${SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX}${taskId}:${runNumber}`
}

export function isSessionTaskMessageLocalId(localId: string | null | undefined): boolean {
    return typeof localId === 'string' && localId.startsWith(SESSION_TASK_MESSAGE_LOCAL_ID_PREFIX)
}

/**
 * Next slot of a fixed grid (`previousRunAt + k * intervalMs`) that lies
 * strictly after `now`. A run that went out late skips the slots it missed
 * instead of catching them up, and later runs stay on the original grid.
 */
export function nextRepeatRunAt(previousRunAt: number, intervalMs: number, now: number): number {
    if (!Number.isFinite(previousRunAt) || intervalMs <= 0) return now
    if (previousRunAt > now) return previousRunAt
    const missed = Math.floor((now - previousRunAt) / intervalMs)
    return previousRunAt + (missed + 1) * intervalMs
}

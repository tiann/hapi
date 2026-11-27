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
/** A session may not hold more active tasks than this; the hub answers `too_many_tasks`. */
export const SESSION_TASK_MAX_ACTIVE_PER_SESSION = 20

export const SessionTaskKindSchema = z.enum(['repeat', 'queue'])
export type SessionTaskKind = z.infer<typeof SessionTaskKindSchema>

export const SessionTaskStateSchema = z.enum(['active', 'paused'])
export type SessionTaskState = z.infer<typeof SessionTaskStateSchema>

/**
 * Why the last run did not go out. Every code clears on the next successful
 * run. None of them pauses the task by itself: the hub keeps a due task due
 * and shows the reason, so it goes on by itself once the cause is gone.
 *
 * - `machine_offline`: the session's machine has no runner.
 * - `session_unavailable`: the session cannot be resumed right now.
 * - `session_archived`: the session is archived; nothing wakes an archived session.
 * - `prompt_indeterminate`: the prompt was sent, but whether the agent took it is unknown;
 *   the queued-message bar offers Retry or Discard.
 * - `prompt_not_taken`: the prompt was sent and the session was woken repeatedly, but the
 *   agent never took it.
 * - `send_failed`: anything else that stopped a run.
 */
export const SessionTaskErrorCodeSchema = z.enum([
    'machine_offline',
    'session_unavailable',
    'session_archived',
    'prompt_indeterminate',
    'prompt_not_taken',
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
    /**
     * When the next prompt goes out. null while paused, and also while a
     * `queue` task waits for the agent to take the prompt it just sent.
     */
    nextRunAt: z.number().nullable(),
    /** A prompt this task sent has not been taken by the agent yet. */
    pending: z.boolean(),
    /** When the task was meant to run first (epoch ms). Resuming a task that has not run yet keeps it. */
    startAt: z.number(),
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

const RemainingItemsSchema = z.array(z.object({ text: TaskTextSchema }).strict())
    .min(1)
    .max(SESSION_TASK_MAX_ITEMS)

/**
 * Changes to an existing task. Every field is optional and at least one is
 * required. Which fields apply depends on the task's kind, which the body
 * does not carry: `text` and `maxRuns` are for a `repeat` task, `items` are
 * the prompts a `queue` task has not sent yet. The hub answers
 * `wrong_task_kind` otherwise.
 */
export const UpdateSessionTaskRequestSchema = z.object({
    paused: z.boolean().optional(),
    text: TaskTextSchema.optional(),
    items: RemainingItemsSchema.optional(),
    intervalMs: IntervalMsSchema.optional(),
    /** null removes the limit. Must not be below the number of prompts already sent. */
    maxRuns: z.number().int().min(1).max(SESSION_TASK_MAX_RUNS).nullable().optional()
}).strict().refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    { message: 'at least one field is required' }
)

export type UpdateSessionTaskRequest = z.infer<typeof UpdateSessionTaskRequestSchema>

export const SessionTaskResponseSchema = z.object({ task: SessionTaskSchema }).strict()
export const SessionTaskListResponseSchema = z.object({ tasks: z.array(SessionTaskSchema) }).strict()

export type SessionTaskResponse = z.infer<typeof SessionTaskResponseSchema>
export type SessionTaskListResponse = z.infer<typeof SessionTaskListResponseSchema>

export const SessionTaskDeleteResponseSchema = z.object({
    ok: z.literal(true),
    /**
     * What became of a prompt the task had sent and the agent had not taken:
     * `none` (there was no such prompt), `cancelled`, `taken` (the agent got it
     * first), or `unconfirmed` (the cancel could not be confirmed; the row stays
     * indeterminate in the queued-message bar).
     */
    prompt: z.enum(['none', 'cancelled', 'taken', 'unconfirmed'])
}).strict()

export type SessionTaskDeleteResponse = z.infer<typeof SessionTaskDeleteResponseSchema>

export const SessionTaskRunOutcomeSchema = z.enum(['sent', 'skipped', 'failed', 'cancelled'])

/** One line of what a task did: a prompt it sent, a slot it skipped, or a run that could not go out. */
export const SessionTaskRunSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    /** The task's id. The task itself is deleted once it finishes; its runs stay. */
    taskId: z.string(),
    taskKind: SessionTaskKindSchema,
    /** 1-based number of the prompt, or null when no prompt was sent. */
    runNumber: z.number().int().positive().nullable(),
    outcome: SessionTaskRunOutcomeSchema,
    /** When this run was due. */
    scheduledFor: z.number().nullable(),
    recordedAt: z.number(),
    /** For `sent`: when the agent took the prompt, or null while it is still waiting. */
    takenAt: z.number().nullable(),
    /** For `skipped` and `failed`: the reason (`previous_prompt_waiting` or a SessionTaskErrorCode). */
    detail: z.string().nullable(),
    /** Start of the prompt's text, so a finished task's runs stay readable. */
    preview: z.string().nullable()
}).strict()

export type SessionTaskRun = z.infer<typeof SessionTaskRunSchema>

export const SessionTaskRunListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional()
}).strict()

export const SessionTaskRunListResponseSchema = z.object({
    runs: z.array(SessionTaskRunSchema)
}).strict()

export type SessionTaskRunListResponse = z.infer<typeof SessionTaskRunListResponseSchema>

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

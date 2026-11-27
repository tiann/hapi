import type { SessionTask, SessionTaskDeleteResponse } from '@hapi/protocol'

/**
 * What the engine's session-task methods answer. The routes map these to
 * HTTP; nothing here is HTTP-shaped itself.
 */

export type CreateSessionTaskResult =
    | { type: 'created'; task: SessionTask }
    /** The session already holds `SESSION_TASK_MAX_ACTIVE_PER_SESSION` active tasks. */
    | { type: 'too-many-tasks' }

export type UpdateSessionTaskResult =
    | { type: 'updated'; task: SessionTask }
    | { type: 'not-found' }
    /** Fields that do not apply to the task's kind (`text`/`maxRuns` on a `queue`, `items` on a `repeat`). */
    | { type: 'wrong-task-kind'; fields: string[] }
    /** `maxRuns` below the number of prompts the task already sent. */
    | { type: 'invalid-max-runs' }

export type RunSessionTaskNowResult =
    | { type: 'queued'; task: SessionTask }
    | { type: 'not-found' }
    /** A prompt of the task is still waiting to be taken; it goes first. */
    | { type: 'prompt-pending'; task: SessionTask }

export type DeleteSessionTaskResult =
    | { type: 'deleted'; prompt: SessionTaskDeleteResponse['prompt'] }
    | { type: 'not-found' }

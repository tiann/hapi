import type { SessionTask, SessionTaskDeleteResponse } from '@hapi/protocol'

/**
 * What the engine's session-task methods answer. The routes map these to
 * HTTP; nothing here is HTTP-shaped itself.
 */

export type UpdateSessionTaskResult =
    | { type: 'updated'; task: SessionTask }
    | { type: 'not-found' }

export type DeleteSessionTaskResult =
    | { type: 'deleted'; prompt: SessionTaskDeleteResponse['prompt'] }
    | { type: 'not-found' }

import { z } from 'zod'

const timestamp = z.number().int().nonnegative().safe()

export const SessionReadStateSchema = z.object({
    sessionId: z.string().min(1),
    lastSeenAt: timestamp,
    manualUnreadAt: timestamp.nullable(),
    version: z.number().int().positive().safe()
})

export const SessionReadMutationSchema = z.object({
    mutationId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    kind: z.enum(['seen', 'unread', 'import-unread']),
    activityAt: timestamp,
    expectedVersion: z.number().int().nonnegative().safe()
})

export const SessionReadUpdateSchema = z.object({
    mutations: z.array(SessionReadMutationSchema).min(1).max(500)
})

export const SessionReadSnapshotSchema = z.object({ states: z.array(SessionReadStateSchema) })
export const SessionReadUpdateResponseSchema = SessionReadSnapshotSchema.extend({
    acceptedSessionIds: z.array(z.string())
})
export type SessionReadState = z.infer<typeof SessionReadStateSchema>
export type SessionReadMutation = z.infer<typeof SessionReadMutationSchema>

/** Untracked sessions remain unread until observed; never import legacy read receipts. */
export function emptySessionReadState(sessionId: string) {
    return { sessionId, lastSeenAt: 0, manualUnreadAt: null, version: 0 }
}

import { z } from 'zod'

/** Shared by every client in a session's namespace. Versions are hub-owned. */
export const SessionReadStateSchema = z.object({
    readRevision: z.number().int().nonnegative().safe(),
    manualUnread: z.boolean(),
    version: z.number().int().nonnegative().safe()
})

export type SessionReadState = z.infer<typeof SessionReadStateSchema>

export const SessionReadStateRequestSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('read'),
        readRevision: z.number().int().nonnegative().safe(),
        expectedVersion: z.number().int().nonnegative().safe()
    }).strict(),
    z.object({
        type: z.literal('unread'),
        expectedVersion: z.number().int().nonnegative().safe()
    }).strict()
])

export type SessionReadStateRequest = z.infer<typeof SessionReadStateRequestSchema>

export const EMPTY_READ_STATE: SessionReadState = { readRevision: 0, manualUnread: false, version: 0 }

/** Full responses and both SSE subscriptions may arrive out of order. */
export function mergeReadState(current: SessionReadState | undefined, incoming: SessionReadState | undefined): SessionReadState | undefined {
    if (!incoming) return current
    if (!current) return incoming
    return {
        ...(incoming.version > current.version ? incoming : current),
        readRevision: Math.max(current.readRevision, incoming.readRevision)
    }
}

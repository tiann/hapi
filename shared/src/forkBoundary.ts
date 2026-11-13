import { z } from 'zod'

/**
 * Fork boundary contract: whoever decides where a fork or rewind cuts the
 * conversation answers the preview and hands back this token; confirm echoes
 * it and the hub re-checks it against the live transcript before mutating
 * anything. No opaque signature: the hub re-derives every field from its own
 * state, and CLI-decided boundaries are re-verified against native history.
 */
export const ForkBoundarySchema = z.object({
    v: z.literal(1),
    mode: z.enum(['current', 'message', 'latestCompleted', 'rewind']),
    /** Boundary row for message and rewind modes. */
    messageLocalId: z.string().min(1).optional(),
    /** hub message epoch (bumped on structural transcript changes). */
    epoch: z.number().int().nonnegative(),
    /** Max seq among invoked rows when the preview was taken. */
    tailSeq: z.number().int().nonnegative(),
    /** CLI-decided modes only: the pinned inclusive native cutoff turn. */
    nativeTurnId: z.string().min(1).optional(),
    /** The source's active state when the preview was taken. The hub always
     *  sets it; the confirm rejects a token whose admission path (live guards
     *  vs archived-fork rules) no longer matches the source. */
    sourceActive: z.boolean().optional()
})

export type ForkBoundary = z.infer<typeof ForkBoundarySchema>

/** What the caller wants to preview; the hub resolves it to a mode. */
export const ForkPreviewRequestSchema = z.object({
    intent: z.enum(['current', 'message', 'rewind']),
    messageLocalId: z.string().min(1).optional()
}).refine(
    (data) => (data.intent === 'message' || data.intent === 'rewind') === Boolean(data.messageLocalId),
    { message: 'message and rewind intents require messageLocalId; current forbids it' }
)

export type ForkPreviewRequest = z.infer<typeof ForkPreviewRequestSchema>

/** One invoked transcript row, shaped like a decrypted chat message so the
 *  web can run its regular normalize/reduce pipeline for display. */
export type ForkPreviewRow = {
    id: string
    seq: number | null
    localId: string | null
    content: unknown
    createdAt: number
    invokedAt?: number | null
}

/** Read-only answer from the boundary owner; carrying the confirm token. */
export type ForkPreviewResponse = {
    mode: ForkBoundary['mode']
    boundary: ForkBoundary
    /** Last FORK_PREVIEW_TAIL_ROWS invoked rows that would be copied into the child. */
    keptTail: ForkPreviewRow[]
    /** message/latestCompleted: the first row beyond the cut. rewind: the
     *  first FORK_PREVIEW_TAIL_ROWS rows that would be deleted from the source. */
    excluded: ForkPreviewRow[]
    counts: { kept: number; excluded: number }
}

/** Number of invoked tail rows the preview returns for display. */
export const FORK_PREVIEW_TAIL_ROWS = 12

/** Returned when the transcript moved since the preview was taken. */
export type ForkBoundaryErrorCode = 'boundary_moved'
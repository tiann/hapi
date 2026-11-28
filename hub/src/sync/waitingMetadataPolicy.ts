import { z } from 'zod'

/** Waiting patch shape from MetadataSchema — validate before persist (#2616). */
const waitingMetadataFieldSchema = z.object({
    since: z.number(),
    reason: z.string().optional(),
}).nullable()

/**
 * Reject malformed `waiting` before create/adopt/update-metadata so a bad
 * patch cannot persist (or ack success then null the whole cached metadata
 * on parse failure).
 */
export function cliMetadataWaitingValid(metadata: unknown): boolean {
    if (metadata === null || metadata === undefined) return true
    if (typeof metadata !== 'object' || Array.isArray(metadata)) return true
    if (!Object.prototype.hasOwnProperty.call(metadata, 'waiting')) return true
    return waitingMetadataFieldSchema.safeParse((metadata as { waiting: unknown }).waiting).success
}

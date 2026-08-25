import { z } from 'zod'
import { DecryptedMessageSchema, ScratchlistEntrySchema, SessionSchema } from './schemas'

/**
 * Session export schema version.
 *
 * v1: session + messages only (#793 / #808)
 * v2: adds scratchlist text + attachment metadata (#1235). Attachment
 *     bytes are intentionally omitted - metadata (id/filename/mime/size/path)
 *     is enough for cold archive; download URLs only work while the session
 *     still exists on the hub.
 */
export const HAPI_SESSION_EXPORT_SCHEMA_VERSION = 2
export const SESSION_EXPORT_MESSAGE_LIMIT = 20_000
export const SESSION_EXPORT_MAX_BYTES = 100 * 1024 * 1024

export const HapiSessionExportSchema = z.object({
    schemaVersion: z.literal(HAPI_SESSION_EXPORT_SCHEMA_VERSION),
    exportedAt: z.number().int().nonnegative(),
    session: SessionSchema,
    messages: z.array(DecryptedMessageSchema),
    scratchlist: z.array(ScratchlistEntrySchema)
})

export type HapiSessionExport = z.infer<typeof HapiSessionExportSchema>

export type HapiSessionExportWarning = {
    type: 'warning'
    count: number
    limit: number
    estimatedBytes: number
}

export type HapiSessionExportTooLarge = {
    type: 'too-large'
    count: number
    estimatedBytes: number
    maxBytes: number
}

export type HapiSessionExportResponse = HapiSessionExport | HapiSessionExportWarning

export type HapiSessionExportResult =
    | { type: 'success'; payload: HapiSessionExport }
    | HapiSessionExportWarning
    | HapiSessionExportTooLarge

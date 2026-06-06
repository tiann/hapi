import { z } from 'zod'
import { DecryptedMessageSchema, SessionSchema } from './schemas'

export const HAPI_SESSION_EXPORT_SCHEMA_VERSION = 1
export const SESSION_EXPORT_MESSAGE_LIMIT = 20_000

export const HapiSessionExportSchema = z.object({
    schemaVersion: z.literal(HAPI_SESSION_EXPORT_SCHEMA_VERSION),
    exportedAt: z.number().int().nonnegative(),
    session: SessionSchema,
    messages: z.array(DecryptedMessageSchema)
})

export type HapiSessionExport = z.infer<typeof HapiSessionExportSchema>

export type HapiSessionExportResult =
    | { type: 'success'; payload: HapiSessionExport }
    | { type: 'too-large'; count: number; limit: number }

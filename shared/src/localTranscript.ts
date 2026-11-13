import { z } from 'zod'
import {
    CodexImportedMessageSchema,
    CodexLocalSessionSummarySchema,
    CodexLocalSessionWithMessagesSchema,
    type OpencodeLocalSessionSummary,
    type OpencodeLocalSessionWithMessages,
    type PiLocalSessionSummary,
    type PiLocalSessionWithMessages
} from './apiTypes'

/**
 * Normalized local-session transcript contract (import registry).
 *
 * Sources (Codex, Pi, OpenCode, Claude) only convert their native history
 * into this shape; the generic hub importer owns target lookup, delta
 * computation, persistence and lifecycle. CLI readers and the hub's legacy
 * runner fallbacks both produce these transcripts so both paths converge on
 * the same result.
 */

export const LOCAL_SESSION_FLAVORS = ['codex', 'pi', 'opencode', 'claude'] as const

export type LocalSessionFlavor = typeof LOCAL_SESSION_FLAVORS[number]

export const MAX_LOCAL_SESSION_IMPORTS = 200

export const LocalImportedMessageContentSchema = z.union([
    CodexImportedMessageSchema,
    // Claude agent turns arrive as their own payload envelope; the web chat
    // normalizer renders them like other agent payloads (commit 6b fills the
    // data shape from the Claude reader).
    z.object({
        role: z.literal('agent'),
        content: z.object({ type: z.literal('claude'), data: z.unknown() }),
        meta: z.object({ sentFrom: z.literal('cli') })
    })
])

export type LocalImportedMessageContent = z.infer<typeof LocalImportedMessageContentSchema>

export const LocalTranscriptMessageSchema = z.object({
    /** Stable per-message id; doubles as the hub-side stored localId. */
    id: z.string().min(1),
    /** Absent -> the import stamps the import time (Codex records carry none). */
    createdAt: z.number().optional(),
    content: LocalImportedMessageContentSchema,
    /** Native position marker (Pi entry id, Claude uuid). */
    anchor: z.string().min(1).optional(),
    /** Native fork boundary recorded for user messages (Pi user entries). */
    historyPoint: z.string().min(1).optional()
})

export type LocalTranscriptMessage = z.infer<typeof LocalTranscriptMessageSchema>

export const LocalTranscriptSummarySchema = z.object({
    flavor: z.enum(LOCAL_SESSION_FLAVORS),
    id: z.string().min(1),
    title: z.string(),
    lastUserMessage: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    file: z.string().min(1),
    modifiedAt: z.number(),
    messageCount: z.number().int().nonnegative().optional(),
    /** Launch hints carried by the source (Pi model/thinkingLevel, OpenCode v2 model). */
    launch: z.object({
        model: z.string().nullable().optional(),
        effort: z.string().nullable().optional()
    }).optional(),
    /** Flavor-only display fields, flattened into list responses unchanged. */
    extra: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional()
})

export type LocalTranscriptSummary = z.infer<typeof LocalTranscriptSummarySchema>

export const LocalTranscriptSchema = LocalTranscriptSummarySchema.extend({
    messages: z.array(LocalTranscriptMessageSchema),
    /** Ordered native anchors of the active branch (Pi activeEntryIds). */
    anchorOrder: z.array(z.string().min(1)).optional(),
    /** Native fork cursor (Pi leafEntryId). */
    cursor: z.string().nullable().optional()
})

export type LocalTranscript = z.infer<typeof LocalTranscriptSchema>

export const ListLocalSessionsRpcRequestSchema = z.object({
    flavor: z.enum(LOCAL_SESSION_FLAVORS),
    cwd: z.string().nullable().optional(),
    sessionIds: z.array(z.string().min(1)).max(MAX_LOCAL_SESSION_IMPORTS).optional()
})

export const ListLocalSessionsRpcResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        sessions: z.array(z.union([LocalTranscriptSchema, LocalTranscriptSummarySchema]))
    }),
    z.object({ success: z.literal(false), error: z.string() })
])

export type ListLocalSessionsRpcRequest = z.infer<typeof ListLocalSessionsRpcRequestSchema>
export type ListLocalSessionsRpcResponse = z.infer<typeof ListLocalSessionsRpcResponseSchema>

/** Codex source shapes (apiTypes exports the schemas only). */
export type CodexLocalSessionSummary = z.infer<typeof CodexLocalSessionSummarySchema>
export type CodexLocalSessionWithMessages = z.infer<typeof CodexLocalSessionWithMessagesSchema>

// ---------------------------------------------------------------------------
// Pure mappers: source shapes -> normalized transcripts.
// ---------------------------------------------------------------------------

function transcriptSummaryBase(parts: {
    flavor: LocalSessionFlavor
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    messageCount?: number
    launch?: LocalTranscriptSummary['launch']
    extra?: LocalTranscriptSummary['extra']
}): LocalTranscriptSummary {
    return {
        flavor: parts.flavor,
        id: parts.id,
        title: parts.title,
        lastUserMessage: parts.lastUserMessage ?? null,
        cwd: parts.cwd ?? null,
        file: parts.file,
        modifiedAt: parts.modifiedAt,
        ...(parts.messageCount !== undefined ? { messageCount: parts.messageCount } : {}),
        ...(parts.launch ? { launch: parts.launch } : {}),
        ...(parts.extra ? { extra: parts.extra } : {})
    }
}

// -- Codex ------------------------------------------------------------------

export function codexToTranscriptSummary(session: CodexLocalSessionSummary): LocalTranscriptSummary {
    return transcriptSummaryBase({
        flavor: 'codex',
        id: session.id,
        title: session.title,
        lastUserMessage: session.lastUserMessage ?? null,
        cwd: session.cwd ?? null,
        file: session.file,
        modifiedAt: session.modifiedAt,
        extra: {
            originator: session.originator ?? null,
            cliVersion: session.cliVersion ?? null,
            source: session.source ?? null,
            threadSource: session.threadSource ?? null,
            forkedFromId: session.forkedFromId ?? null
        }
    })
}

export function codexToTranscript(session: CodexLocalSessionWithMessages): LocalTranscript {
    return {
        ...codexToTranscriptSummary(session),
        // No createdAt: Codex transcripts carry no per-record timestamps, so
        // the importer stamps the import time (existing hub behavior).
        messages: session.messages.map((content, index) => ({
            id: `codex-desktop:${session.id}:${index}`,
            content
        }))
    }
}

// -- Pi ---------------------------------------------------------------------

export function piToTranscriptSummary(session: PiLocalSessionSummary): LocalTranscriptSummary {
    return transcriptSummaryBase({
        flavor: 'pi',
        id: session.id,
        title: session.title,
        lastUserMessage: session.lastUserMessage ?? null,
        cwd: session.cwd ?? null,
        file: session.file,
        modifiedAt: session.modifiedAt,
        messageCount: session.messageCount,
        launch: { model: session.model ?? null, effort: session.thinkingLevel ?? null },
        extra: {
            model: session.model ?? null,
            thinkingLevel: session.thinkingLevel ?? null,
            leafEntryId: session.leafEntryId ?? null
        }
    })
}

export function piToTranscript(session: PiLocalSessionWithMessages): LocalTranscript {
    return {
        ...piToTranscriptSummary(session),
        messages: session.messages.map((message) => ({
            id: message.localId,
            createdAt: message.createdAt,
            content: message.content,
            anchor: message.entryId,
            ...(message.content.role === 'user' ? { historyPoint: message.entryId } : {})
        })),
        anchorOrder: [...session.activeEntryIds],
        cursor: session.leafEntryId ?? null
    }
}

// -- OpenCode ---------------------------------------------------------------

export function opencodeToTranscriptSummary(session: OpencodeLocalSessionSummary): LocalTranscriptSummary {
    return transcriptSummaryBase({
        flavor: 'opencode',
        id: session.id,
        title: session.title,
        lastUserMessage: session.lastUserMessage ?? null,
        cwd: session.cwd ?? null,
        file: session.file,
        modifiedAt: session.modifiedAt
    })
}

export function opencodeToTranscript(session: OpencodeLocalSessionWithMessages): LocalTranscript {
    return {
        ...opencodeToTranscriptSummary(session),
        messages: session.messages.map((message) => ({
            id: message.localId,
            createdAt: message.createdAt,
            content: message.content
        }))
    }
}
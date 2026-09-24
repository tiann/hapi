import { z } from 'zod'

/**
 * Resume-size guard (hub OOM incident, 2026-09).
 *
 * Resuming/reopening an existing session makes the agent replay its full
 * thread into the hub: on BIGNUC, resuming a ~212k-message / ~214 MB Codex
 * session after a WSL recycle ballooned hub RSS from ~3.6 GB to ~5.5 GB and
 * :3006 started returning 500s. Web reads are paged (≤200 messages) but the
 * resume/attach path is not, so oversized sessions must never be reattached
 * without explicit confirmation.
 *
 * Thresholds are locked by that incident's postmortem:
 * - soft (require confirm): >5,000 messages OR >10 MB stored content
 * - hard (refuse, explicit force required): >10,000 messages OR >20 MB
 *
 * `contentBytes` counts bytes as stored in the hub DB (`SUM(LENGTH(content))`
 * over the session's message rows). Compressed rows therefore undercount the
 * decoded size; the message-count threshold is the backstop for that.
 */
export const SESSION_SIZE_SOFT_MAX_MESSAGES = 5_000
export const SESSION_SIZE_SOFT_MAX_CONTENT_BYTES = 10 * 1024 * 1024
export const SESSION_SIZE_HARD_MAX_MESSAGES = 10_000
export const SESSION_SIZE_HARD_MAX_CONTENT_BYTES = 20 * 1024 * 1024

export const SessionSizeStatsSchema = z.object({
    messageCount: z.number().int().min(0),
    contentBytes: z.number().int().min(0)
})

export type SessionSizeStats = z.infer<typeof SessionSizeStatsSchema>

export const SessionSizeVerdictSchema = z.enum(['ok', 'soft', 'hard'])

export type SessionSizeVerdict = z.infer<typeof SessionSizeVerdictSchema>

/** Wire shape of GET /cli/sessions/:id/size-guard. */
export const SessionSizeGuardResponseSchema = SessionSizeStatsSchema.extend({
    verdict: SessionSizeVerdictSchema
})

export type SessionSizeGuardResponse = z.infer<typeof SessionSizeGuardResponseSchema>

export function evaluateSessionSize(stats: SessionSizeStats): SessionSizeVerdict {
    if (
        stats.messageCount > SESSION_SIZE_HARD_MAX_MESSAGES
        || stats.contentBytes > SESSION_SIZE_HARD_MAX_CONTENT_BYTES
    ) {
        return 'hard'
    }
    if (
        stats.messageCount > SESSION_SIZE_SOFT_MAX_MESSAGES
        || stats.contentBytes > SESSION_SIZE_SOFT_MAX_CONTENT_BYTES
    ) {
        return 'soft'
    }
    return 'ok'
}

export function formatSessionSize(stats: SessionSizeStats): string {
    const mb = (stats.contentBytes / (1024 * 1024)).toFixed(1)
    return `${stats.messageCount} messages / ${mb} MB of stored content`
}

/** Human-readable refusal shared verbatim by the hub routes and the CLI. */
export function sessionSizeGuardMessage(stats: SessionSizeStats, verdict: 'soft' | 'hard'): string {
    if (verdict === 'hard') {
        return `Session has ${formatSessionSize(stats)}, over the hard resume limit `
            + `(${SESSION_SIZE_HARD_MAX_MESSAGES} messages or ${SESSION_SIZE_HARD_MAX_CONTENT_BYTES / (1024 * 1024)} MB). `
            + 'Resuming replays the full history into the hub and can exhaust its memory; force is required to attach anyway.'
    }
    return `Session has ${formatSessionSize(stats)}, over the resume confirmation threshold `
        + `(${SESSION_SIZE_SOFT_MAX_MESSAGES} messages or ${SESSION_SIZE_SOFT_MAX_CONTENT_BYTES / (1024 * 1024)} MB). `
        + 'Resuming replays the full history into the hub; confirm with force to attach anyway.'
}

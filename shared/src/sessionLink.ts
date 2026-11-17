import { z } from 'zod'

export const SessionLinkKindSchema = z.enum(['peer', 'fork', 'branch'])
export type SessionLinkKind = z.infer<typeof SessionLinkKindSchema>

export const SessionParentLinkSchema = z.object({
    parentSessionId: z.string().min(1),
    kind: SessionLinkKindSchema
})
export type SessionParentLink = z.infer<typeof SessionParentLinkSchema>

type SessionParentLinkSource = {
    parentSessionId?: string | null
    conversationBranch?: { sourceSessionId?: string | null } | null
    forkedFrom?: string | null
} | null | undefined

function nonEmptyId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

/**
 * Resolves the canonical parent-session link for a session from its metadata.
 * Self-links are rejected so cyclic or malformed metadata never produces loops.
 */
export function resolveSessionParentLink(
    metadata: SessionParentLinkSource,
    ownSessionId?: string
): SessionParentLink | null {
    if (!metadata) return null

    const peerParentId = nonEmptyId(metadata.parentSessionId)
    if (peerParentId) {
        return ownSessionId && peerParentId === ownSessionId
            ? null
            : { parentSessionId: peerParentId, kind: 'peer' }
    }

    const branchParentId = nonEmptyId(metadata.conversationBranch?.sourceSessionId)
    if (branchParentId) {
        return ownSessionId && branchParentId === ownSessionId
            ? null
            : { parentSessionId: branchParentId, kind: 'branch' }
    }

    const forkParentId = nonEmptyId(metadata.forkedFrom)
    if (forkParentId) {
        return ownSessionId && forkParentId === ownSessionId
            ? null
            : { parentSessionId: forkParentId, kind: 'fork' }
    }

    return null
}

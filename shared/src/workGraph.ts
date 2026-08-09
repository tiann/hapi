import { z } from 'zod'

/**
 * Structured principal for A2A work-graph ledger writes (RFC Layer 1 / P1).
 * Non-human principals must name an accountable human owner via on_behalf_of.
 */
export const WorkGraphPrincipalSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('human'),
        id: z.string().min(1)
    }),
    z.object({
        kind: z.literal('agent'),
        id: z.string().min(1),
        on_behalf_of: z.string().min(1)
    }),
    z.object({
        kind: z.literal('service'),
        id: z.string().min(1),
        on_behalf_of: z.string().min(1)
    })
])
export type WorkGraphPrincipal = z.infer<typeof WorkGraphPrincipalSchema>

export const WorkGraphArtifactRefSchema = z.object({
    kind: z.string().min(1),
    url: z.string().optional(),
    title: z.string().optional(),
    ref: z.string().nullable().optional(),
    source: z.string().optional(),
    created_at: z.number().optional()
}).passthrough()
export type WorkGraphArtifactRef = z.infer<typeof WorkGraphArtifactRefSchema>

/** Open vocabulary; common Layer 1 types listed for docs, not enforced as enum. */
export const WORK_GRAPH_EVENT_TYPES = ['work_ad', 'handoff', 'handoff_receipt'] as const

export const WorkGraphEventCreateSchema = z.object({
    source_kind: z.string().min(1),
    source_ref: z.string().min(1),
    sink_kind: z.string().min(1).optional(),
    sink_ref: z.string().min(1).optional(),
    event_type: z.string().min(1),
    summary: z.string().optional(),
    payload_json: z.unknown().optional(),
    artifact_refs: z.array(WorkGraphArtifactRefSchema).optional(),
    tags: z.array(z.string()).optional(),
    related_session_id: z.string().min(1).optional(),
    related_event_id: z.string().min(1).optional(),
    provenance: z.string().optional(),
    idempotency_key: z.string().min(1).optional(),
    dedupe_key: z.string().min(1).optional(),
    confidence: z.number().optional(),
    severity: z.string().optional(),
    expires_at: z.number().optional(),
    principal: WorkGraphPrincipalSchema
})
export type WorkGraphEventCreate = z.infer<typeof WorkGraphEventCreateSchema>

export const WorkGraphEventLinkCreateSchema = z.object({
    from_event_id: z.string().min(1),
    to_event_id: z.string().min(1),
    relation_type: z.string().min(1),
    metadata_json: z.unknown().optional()
})
export type WorkGraphEventLinkCreate = z.infer<typeof WorkGraphEventLinkCreateSchema>

export type WorkGraphEvent = {
    id: string
    ts: number
    sourceKind: string
    sourceRef: string
    sinkKind: string | null
    sinkRef: string | null
    eventType: string
    summary: string | null
    payloadJson: unknown | null
    artifactRefs: WorkGraphArtifactRef[]
    tags: string[]
    relatedSessionId: string | null
    relatedEventId: string | null
    provenance: string | null
    idempotencyKey: string | null
    dedupeKey: string | null
    confidence: number | null
    severity: string | null
    expiresAt: number | null
    namespace: string
    principal: WorkGraphPrincipal
}

export type WorkGraphEventLink = {
    id: string
    fromEventId: string
    toEventId: string
    relationType: string
    createdAt: number
    metadataJson: unknown | null
    namespace: string
}

/**
 * Kill criterion from the A2A RFC: a non-human principal with no resolvable
 * human owner must be refused. Schema already requires on_behalf_of for
 * agent/service; this is the shared runtime check for callers that build
 * principals without going through Zod.
 */
export function isPrincipalAccountable(principal: WorkGraphPrincipal): boolean {
    if (principal.kind === 'human') {
        return principal.id.trim().length > 0
    }
    return typeof principal.on_behalf_of === 'string' && principal.on_behalf_of.trim().length > 0
}

/**
 * Hub HTTP writes: the accountable human must match the authenticated user.
 * Humans write as themselves; agents/services write only under that owner.
 */
export function principalMatchesAuthenticatedOwner(
    principal: WorkGraphPrincipal,
    ownerUserId: number | string
): boolean {
    const ownerId = String(ownerUserId)
    if (principal.kind === 'human') {
        return principal.id === ownerId
    }
    return principal.on_behalf_of === ownerId
}

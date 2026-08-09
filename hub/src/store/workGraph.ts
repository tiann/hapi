import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import {
    type WorkGraphArtifactRef,
    type WorkGraphEvent,
    type WorkGraphEventCreate,
    WorkGraphEventCreateSchema,
    type WorkGraphEventLink,
    type WorkGraphEventLinkCreate,
    type WorkGraphPrincipal,
    WorkGraphPrincipalSchema,
    isPrincipalAccountable
} from '@hapi/protocol'

export class WorkGraphPrincipalError extends Error {
    readonly code = 'principal_refused' as const

    constructor(message: string) {
        super(message)
        this.name = 'WorkGraphPrincipalError'
    }
}

export class WorkGraphValidationError extends Error {
    readonly code = 'invalid_event' as const

    constructor(message: string) {
        super(message)
        this.name = 'WorkGraphValidationError'
    }
}

export class WorkGraphNotFoundError extends Error {
    readonly code = 'not_found' as const

    constructor(message: string) {
        super(message)
        this.name = 'WorkGraphNotFoundError'
    }
}

type EventRow = {
    id: string
    ts: number
    source_kind: string
    source_ref: string
    sink_kind: string | null
    sink_ref: string | null
    event_type: string
    summary: string | null
    payload_json: string | null
    artifact_refs: string
    tags: string
    related_session_id: string | null
    related_event_id: string | null
    provenance: string | null
    idempotency_key: string | null
    dedupe_key: string | null
    confidence: number | null
    severity: string | null
    expires_at: number | null
    namespace: string
    principal_json: string
}

type LinkRow = {
    id: string
    from_event_id: string
    to_event_id: string
    relation_type: string
    created_at: number
    metadata_json: string | null
    namespace: string
}

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
    try {
        const parsed = JSON.parse(raw) as unknown
        return Array.isArray(parsed) ? parsed as T[] : fallback
    } catch {
        return fallback
    }
}

function parseJsonUnknown(raw: string | null): unknown | null {
    if (raw === null) return null
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return null
    }
}

function toEvent(row: EventRow): WorkGraphEvent {
    return {
        id: row.id,
        ts: row.ts,
        sourceKind: row.source_kind,
        sourceRef: row.source_ref,
        sinkKind: row.sink_kind,
        sinkRef: row.sink_ref,
        eventType: row.event_type,
        summary: row.summary,
        payloadJson: parseJsonUnknown(row.payload_json),
        artifactRefs: parseJsonArray<WorkGraphArtifactRef>(row.artifact_refs, []),
        tags: parseJsonArray<string>(row.tags, []),
        relatedSessionId: row.related_session_id,
        relatedEventId: row.related_event_id,
        provenance: row.provenance,
        idempotencyKey: row.idempotency_key,
        dedupeKey: row.dedupe_key,
        confidence: row.confidence,
        severity: row.severity,
        expiresAt: row.expires_at,
        namespace: row.namespace,
        principal: parsePrincipal(row.principal_json)
    }
}

function parsePrincipal(raw: string): WorkGraphPrincipal {
    const parsed = parseJsonUnknown(raw)
    const result = WorkGraphPrincipalSchema.safeParse(parsed)
    if (result.success) {
        return result.data
    }
    // Corrupt row must not 500 the whole list endpoint.
    return { kind: 'human', id: 'invalid' }
}

function toLink(row: LinkRow): WorkGraphEventLink {
    return {
        id: row.id,
        fromEventId: row.from_event_id,
        toEventId: row.to_event_id,
        relationType: row.relation_type,
        createdAt: row.created_at,
        metadataJson: parseJsonUnknown(row.metadata_json),
        namespace: row.namespace
    }
}

export type InsertWorkGraphEventResult = {
    event: WorkGraphEvent
    inserted: boolean
}

export function insertWorkGraphEvent(
    db: Database,
    namespace: string,
    input: WorkGraphEventCreate,
    options?: { id?: string; ts?: number }
): InsertWorkGraphEventResult {
    // All writers (HTTP + notify ingest + future callers) share one ledger
    // bound: schema max lengths / payload size. Typed callers can still
    // bypass TypeScript with forged objects; this is the choke point.
    const parsed = WorkGraphEventCreateSchema.safeParse(input)
    if (!parsed.success) {
        throw new WorkGraphValidationError(
            parsed.error.issues[0]?.message ?? 'Invalid work-graph event'
        )
    }
    const eventInput = parsed.data

    if (!isPrincipalAccountable(eventInput.principal)) {
        throw new WorkGraphPrincipalError(
            'Non-human principal requires a resolvable human owner via on_behalf_of'
        )
    }

    if (eventInput.idempotency_key) {
        const existing = db.prepare(`
            SELECT * FROM events
            WHERE namespace = ? AND idempotency_key = ?
            LIMIT 1
        `).get(namespace, eventInput.idempotency_key) as EventRow | undefined
        if (existing) {
            return { event: toEvent(existing), inserted: false }
        }
    }

    const id = options?.id ?? randomUUID()
    const ts = options?.ts ?? Date.now()
    const artifactRefs = JSON.stringify(eventInput.artifact_refs ?? [])
    const tags = JSON.stringify(eventInput.tags ?? [])
    const payloadJson = eventInput.payload_json === undefined
        ? null
        : JSON.stringify(eventInput.payload_json)
    const principalJson = JSON.stringify(eventInput.principal)

    try {
        db.prepare(`
            INSERT INTO events (
                id, ts,
                source_kind, source_ref,
                sink_kind, sink_ref,
                event_type, summary, payload_json,
                artifact_refs, tags,
                related_session_id, related_event_id,
                provenance, idempotency_key, dedupe_key,
                confidence, severity, expires_at,
                namespace, principal_json
            ) VALUES (
                @id, @ts,
                @source_kind, @source_ref,
                @sink_kind, @sink_ref,
                @event_type, @summary, @payload_json,
                @artifact_refs, @tags,
                @related_session_id, @related_event_id,
                @provenance, @idempotency_key, @dedupe_key,
                @confidence, @severity, @expires_at,
                @namespace, @principal_json
            )
        `).run({
            id,
            ts,
            source_kind: eventInput.source_kind,
            source_ref: eventInput.source_ref,
            sink_kind: eventInput.sink_kind ?? null,
            sink_ref: eventInput.sink_ref ?? null,
            event_type: eventInput.event_type,
            summary: eventInput.summary ?? null,
            payload_json: payloadJson,
            artifact_refs: artifactRefs,
            tags,
            related_session_id: eventInput.related_session_id ?? null,
            related_event_id: eventInput.related_event_id ?? null,
            provenance: eventInput.provenance ?? null,
            idempotency_key: eventInput.idempotency_key ?? null,
            dedupe_key: eventInput.dedupe_key ?? null,
            confidence: eventInput.confidence ?? null,
            severity: eventInput.severity ?? null,
            expires_at: eventInput.expires_at ?? null,
            namespace,
            principal_json: principalJson
        })
    } catch (error) {
        // Race on idempotency unique index: return the winner's row.
        if (eventInput.idempotency_key) {
            const existing = db.prepare(`
                SELECT * FROM events
                WHERE namespace = ? AND idempotency_key = ?
                LIMIT 1
            `).get(namespace, eventInput.idempotency_key) as EventRow | undefined
            if (existing) {
                return { event: toEvent(existing), inserted: false }
            }
        }
        throw error
    }

    const row = db.prepare('SELECT * FROM events WHERE id = ? AND namespace = ?')
        .get(id, namespace) as EventRow
    return { event: toEvent(row), inserted: true }
}

export function getWorkGraphEventByNamespace(
    db: Database,
    eventId: string,
    namespace: string
): WorkGraphEvent | null {
    const row = db.prepare('SELECT * FROM events WHERE id = ? AND namespace = ?')
        .get(eventId, namespace) as EventRow | undefined
    return row ? toEvent(row) : null
}

export function listWorkGraphEventsByRelatedSession(
    db: Database,
    namespace: string,
    relatedSessionId: string,
    options?: { limit?: number }
): WorkGraphEvent[] {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500)
    const rows = db.prepare(`
        SELECT * FROM events
        WHERE namespace = ? AND related_session_id = ?
        ORDER BY ts DESC
        LIMIT ?
    `).all(namespace, relatedSessionId, limit) as EventRow[]
    return rows.map(toEvent)
}

export function insertWorkGraphEventLink(
    db: Database,
    namespace: string,
    input: WorkGraphEventLinkCreate,
    options?: { id?: string; createdAt?: number }
): WorkGraphEventLink {
    const fromEvent = getWorkGraphEventByNamespace(db, input.from_event_id, namespace)
    if (!fromEvent) {
        throw new WorkGraphNotFoundError('from_event_id not found in namespace')
    }
    const toEvent = getWorkGraphEventByNamespace(db, input.to_event_id, namespace)
    if (!toEvent) {
        throw new WorkGraphNotFoundError('to_event_id not found in namespace')
    }

    const id = options?.id ?? randomUUID()
    const createdAt = options?.createdAt ?? Date.now()
    const metadataJson = input.metadata_json === undefined
        ? null
        : JSON.stringify(input.metadata_json)

    db.prepare(`
        INSERT INTO event_links (
            id, from_event_id, to_event_id, relation_type,
            created_at, metadata_json, namespace
        ) VALUES (
            @id, @from_event_id, @to_event_id, @relation_type,
            @created_at, @metadata_json, @namespace
        )
    `).run({
        id,
        from_event_id: input.from_event_id,
        to_event_id: input.to_event_id,
        relation_type: input.relation_type,
        created_at: createdAt,
        metadata_json: metadataJson,
        namespace
    })

    const row = db.prepare('SELECT * FROM event_links WHERE id = ? AND namespace = ?')
        .get(id, namespace) as LinkRow
    return toLink(row)
}

export function listWorkGraphEventLinksForEvent(
    db: Database,
    namespace: string,
    eventId: string
): WorkGraphEventLink[] {
    const rows = db.prepare(`
        SELECT * FROM event_links
        WHERE namespace = ?
          AND (from_event_id = ? OR to_event_id = ?)
        ORDER BY created_at ASC
    `).all(namespace, eventId, eventId) as LinkRow[]
    return rows.map(toLink)
}

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredSession, VersionedUpdateResult } from './types'
import { safeJsonParse } from './json'
import { updateVersionedField } from './versionedUpdates'

// Carry-forward fields that the hub preserves across any metadata
// replacement when the incoming write omits them.
//
// The CLI's archive transition (cli/src/agent/runnerLifecycle.ts
// archiveAndClose) spreads `currentMetadata` from the session client's
// local cache; if that cache is `null` (e.g. the row's metadata failed
// Zod parse at bootstrap and got nulled out in cli/src/api/api.ts) or
// stale, the resulting payload is sparse and the unconditional REPLACE
// in updateSessionMetadata wipes whatever it omits. That breaks resume
// even though the on-disk chat data still exists.
//
// Three preservation tiers cover the failure modes:
//
//   - PARSE_IDENTITY_FIELDS: required by MetadataSchema in
//     shared/src/schemas.ts. Without these, hub session cache and CLI
//     getSession reject the row with safeParse → metadata becomes null
//     downstream and resume cannot find a path even when the resume
//     token survived.
//
//   - ROUTING_FIELDS: flavor + machineId. `flavor` is what
//     hub/src/web/routes/sessions.ts and hub/src/sync/syncEngine.ts use
//     to pick which session id field to read; if it's dropped, the
//     `?? 'claude'` fallback misroutes a Cursor/Codex/Gemini session as
//     Claude and the preserved token is ignored. `machineId` is the
//     filter the CLI's resumable listing uses to scope rows to the
//     current host; without it the row drops out of the resume picker.
//
//   - SIMPLE_RESUME_TOKENS: flavor-specific resume identifiers that are
//     write-once-keep semantics. Mirror of pickExistingSessionMetadata
//     in cli/src/agent/sessionFactory.ts.
//
// `cursorSessionProtocol` is paired with `cursorSessionId`: protocol is
// tied to a specific chat id, so a write that explicitly sets a new
// `cursorSessionId` must drop a stale prior protocol. Handled in
// preserveCursorProtocolPair below.
//
// Explicit-clear sentinel: when `next` sets a carry-forward field to
// `null`, the merge drops the key entirely from the output (the
// resulting blob has neither the prior value nor `null`). This lets
// callers intentionally remove a preserved field — e.g.
// `cli/src/codex/session.ts` `resetCodexThread()` clears the codex
// thread id with `codexSessionId: null` so a `/clear` command actually
// drops the persisted thread. `undefined` (key missing from `next`)
// continues to mean "carry forward".
const PARSE_IDENTITY_FIELDS = ['path', 'host'] as const

const ROUTING_FIELDS = ['flavor', 'machineId'] as const

const SIMPLE_RESUME_TOKENS = [
    'claudeSessionId',
    'codexSessionId',
    'geminiSessionId',
    'opencodeSessionId',
    'grokSessionId',
    'cursorSessionId',
    'kimiSessionId'
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function carryForwardIfMissing(
    prior: Record<string, unknown>,
    next: Record<string, unknown>,
    merged: Record<string, unknown> | null,
    fields: ReadonlyArray<string>
): Record<string, unknown> | null {
    let result = merged
    for (const field of fields) {
        // Explicit-clear sentinel: `null` in next means "drop this field".
        // Strip it from the merged output so the persisted blob stays
        // schema-clean (MetadataSchema fields are `string().optional()`
        // — string|undefined, not nullable).
        if (next[field] === null) {
            if (result === null) {
                result = { ...next }
            }
            delete result[field]
            continue
        }
        if (next[field] === undefined && prior[field] !== undefined) {
            if (result === null) {
                result = { ...next }
            }
            result[field] = prior[field]
        }
    }
    return result
}

function preserveCursorProtocolPair(
    prior: Record<string, unknown>,
    next: Record<string, unknown>,
    merged: Record<string, unknown> | null
): Record<string, unknown> | null {
    // If next explicitly sets cursorSessionId, the protocol is tied to
    // the new id — never carry over the prior protocol. The next write
    // can include its own cursorSessionProtocol if it knows the protocol.
    if (next.cursorSessionId !== undefined) {
        return merged
    }
    // Otherwise next is silent on the id (and possibly the protocol);
    // carry over the prior protocol so it stays paired with the prior id
    // (which is preserved via SIMPLE_RESUME_TOKENS above).
    if (next.cursorSessionProtocol === undefined && prior.cursorSessionProtocol !== undefined) {
        const result = merged ?? { ...next }
        result.cursorSessionProtocol = prior.cursorSessionProtocol
        return result
    }
    return merged
}

export function mergeSessionMetadata(prior: unknown, next: unknown): unknown {
    if (!isPlainObject(prior) || !isPlainObject(next)) {
        return next
    }
    let merged: Record<string, unknown> | null = null
    merged = carryForwardIfMissing(prior, next, merged, PARSE_IDENTITY_FIELDS)
    merged = carryForwardIfMissing(prior, next, merged, ROUTING_FIELDS)
    merged = carryForwardIfMissing(prior, next, merged, SIMPLE_RESUME_TOKENS)
    merged = preserveCursorProtocolPair(prior, next, merged)
    return merged ?? next
}

type DbSessionRow = {
    id: string
    tag: string | null
    namespace: string
    machine_id: string | null
    created_at: number
    updated_at: number
    metadata: string | null
    metadata_version: number
    agent_state: string | null
    agent_state_version: number
    model: string | null
    model_reasoning_effort: string | null
    effort: string | null
    service_tier: string | null
    todos: string | null
    todos_updated_at: number | null
    team_state: string | null
    team_state_updated_at: number | null
    active: number
    active_at: number | null
    seq: number
}

function toStoredSession(row: DbSessionRow): StoredSession {
    return {
        id: row.id,
        tag: row.tag,
        namespace: row.namespace,
        machineId: row.machine_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        agentState: safeJsonParse(row.agent_state),
        agentStateVersion: row.agent_state_version,
        model: row.model,
        modelReasoningEffort: row.model_reasoning_effort,
        effort: row.effort,
        serviceTier: row.service_tier,
        todos: safeJsonParse(row.todos),
        todosUpdatedAt: row.todos_updated_at,
        teamState: safeJsonParse(row.team_state),
        teamStateUpdatedAt: row.team_state_updated_at,
        active: row.active === 1,
        activeAt: row.active_at,
        seq: row.seq
    }
}

export function getOrCreateSession(
    db: Database,
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string,
    model?: string,
    effort?: string,
    modelReasoningEffort?: string,
    requestedId?: string
): StoredSession {
    const existing = db.prepare(
        'SELECT * FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1'
    ).get(tag, namespace) as DbSessionRow | undefined

    if (existing) {
        if (requestedId && existing.id !== requestedId) {
            throw new SessionIdentityConflictError('Session tag is already bound to a different id')
        }
        return toStoredSession(existing)
    }

    const now = Date.now()
    const id = requestedId ?? randomUUID()

    if (requestedId) {
        const existingById = getSession(db, requestedId)
        if (existingById) {
            if (existingById.namespace === namespace && existingById.tag === tag) {
                return existingById
            }
            throw new SessionIdentityConflictError('Session id is already bound to a different session')
        }
    }

    const metadataJson = JSON.stringify(metadata)
    const agentStateJson = agentState === null || agentState === undefined ? null : JSON.stringify(agentState)

    db.prepare(`
        INSERT INTO sessions (
            id, tag, namespace, machine_id, created_at, updated_at,
            metadata, metadata_version,
            agent_state, agent_state_version,
            model,
            model_reasoning_effort,
            effort,
            todos, todos_updated_at,
            active, active_at, seq
        ) VALUES (
            @id, @tag, @namespace, NULL, @created_at, @updated_at,
            @metadata, 1,
            @agent_state, 1,
            @model,
            @model_reasoning_effort,
            @effort,
            NULL, NULL,
            0, @active_at, 0
        )
    `).run({
        id,
        tag,
        namespace,
        created_at: now,
        updated_at: now,
        // Never persist NULL — CLI SessionSchema requires numeric activeAt.
        // Legacy rows may still be NULL; sessionCache coerces on read.
        active_at: now,
        metadata: metadataJson,
        agent_state: agentStateJson,
        model: model ?? null,
        model_reasoning_effort: modelReasoningEffort ?? null,
        effort: effort ?? null
    })

    const row = getSession(db, id)
    if (!row) {
        throw new Error('Failed to create session')
    }
    return row
}

export class SessionIdentityConflictError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SessionIdentityConflictError'
    }
}

export function updateSessionMetadata(
    db: Database,
    id: string,
    metadata: unknown,
    expectedVersion: number,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt !== false

    try {
        return db.transaction((): VersionedUpdateResult<unknown | null> => {
            const priorRow = db.prepare(
                'SELECT metadata FROM sessions WHERE id = ? AND namespace = ?'
            ).get(id, namespace) as { metadata: string | null } | undefined

            const prior = priorRow ? safeJsonParse(priorRow.metadata) : null
            const merged = mergeSessionMetadata(prior, metadata)

            return updateVersionedField({
                db,
                table: 'sessions',
                id,
                namespace,
                field: 'metadata',
                versionField: 'metadata_version',
                expectedVersion,
                value: merged,
                encode: (value) => {
                    const json = JSON.stringify(value)
                    return json === undefined ? null : json
                },
                decode: safeJsonParse,
                setClauses: [
                    'updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END',
                    'seq = seq + 1'
                ],
                params: {
                    updated_at: now,
                    touch_updated_at: touchUpdatedAt ? 1 : 0
                }
            })
        })()
    } catch {
        return { result: 'error' }
    }
}

export function updateSessionAgentState(
    db: Database,
    id: string,
    agentState: unknown,
    expectedVersion: number,
    namespace: string
): VersionedUpdateResult<unknown | null> {
    const now = Date.now()
    const normalized = agentState ?? null

    return updateVersionedField({
        db,
        table: 'sessions',
        id,
        namespace,
        field: 'agent_state',
        versionField: 'agent_state_version',
        expectedVersion,
        value: normalized,
        encode: (value) => (value === null ? null : JSON.stringify(value)),
        decode: safeJsonParse,
        setClauses: ['updated_at = @updated_at', 'seq = seq + 1'],
        params: { updated_at: now }
    })
}

export function setSessionTodos(
    db: Database,
    id: string,
    todos: unknown,
    todosUpdatedAt: number,
    namespace: string
): boolean {
    try {
        const json = todos === null || todos === undefined ? null : JSON.stringify(todos)
        const result = db.prepare(`
            UPDATE sessions
            SET todos = @todos,
                todos_updated_at = @todos_updated_at,
                updated_at = CASE WHEN updated_at > @updated_at THEN updated_at ELSE @updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND (todos_updated_at IS NULL OR todos_updated_at < @todos_updated_at)
        `).run({
            id,
            todos: json,
            todos_updated_at: todosUpdatedAt,
            updated_at: todosUpdatedAt,
            namespace
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionTeamState(
    db: Database,
    id: string,
    teamState: unknown,
    updatedAt: number,
    namespace: string
): boolean {
    try {
        const json = teamState === null || teamState === undefined ? null : JSON.stringify(teamState)
        const result = db.prepare(`
            UPDATE sessions
            SET team_state = @team_state,
                team_state_updated_at = @team_state_updated_at,
                updated_at = CASE WHEN updated_at > @updated_at THEN updated_at ELSE @updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND (team_state_updated_at IS NULL OR team_state_updated_at < @team_state_updated_at)
        `).run({
            id,
            team_state: json,
            team_state_updated_at: updatedAt,
            updated_at: updatedAt,
            namespace
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionModel(
    db: Database,
    id: string,
    model: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): boolean {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = db.prepare(`
            UPDATE sessions
            SET model = @model,
                updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND model IS NOT @model
        `).run({
            id,
            namespace,
            model,
            updated_at: now,
            touch_updated_at: touchUpdatedAt ? 1 : 0
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionModelReasoningEffort(
    db: Database,
    id: string,
    modelReasoningEffort: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): boolean {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = db.prepare(`
            UPDATE sessions
            SET model_reasoning_effort = @model_reasoning_effort,
                updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND model_reasoning_effort IS NOT @model_reasoning_effort
        `).run({
            id,
            namespace,
            model_reasoning_effort: modelReasoningEffort,
            updated_at: now,
            touch_updated_at: touchUpdatedAt ? 1 : 0
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionServiceTier(
    db: Database,
    id: string,
    serviceTier: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): boolean {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = db.prepare(`
            UPDATE sessions
            SET service_tier = @service_tier,
                updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND service_tier IS NOT @service_tier
        `).run({
            id,
            namespace,
            service_tier: serviceTier,
            updated_at: now,
            touch_updated_at: touchUpdatedAt ? 1 : 0
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionEffort(
    db: Database,
    id: string,
    effort: string | null,
    namespace: string,
    options?: { touchUpdatedAt?: boolean }
): boolean {
    const now = Date.now()
    const touchUpdatedAt = options?.touchUpdatedAt === true

    try {
        const result = db.prepare(`
            UPDATE sessions
            SET effort = @effort,
                updated_at = CASE WHEN @touch_updated_at = 1 THEN @updated_at ELSE updated_at END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND effort IS NOT @effort
        `).run({
            id,
            namespace,
            effort,
            updated_at: now,
            touch_updated_at: touchUpdatedAt ? 1 : 0
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function setSessionActive(
    db: Database,
    id: string,
    active: boolean,
    activeAt: number,
    namespace: string
): boolean {
    try {
        const result = db.prepare(`
            UPDATE sessions
            SET active = @active,
                active_at = CASE
                    WHEN active_at IS NULL OR active_at < @active_at THEN @active_at
                    ELSE active_at
                END,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND (active IS NOT @active OR active_at IS NULL OR active_at < @active_at)
        `).run({
            id,
            namespace,
            active: active ? 1 : 0,
            active_at: activeAt
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function touchSessionUpdatedAt(
    db: Database,
    id: string,
    updatedAt: number,
    namespace: string
): boolean {
    try {
        const result = db.prepare(`
            UPDATE sessions
            SET updated_at = @updated_at,
                seq = seq + 1
            WHERE id = @id
              AND namespace = @namespace
              AND updated_at < @updated_at
        `).run({
            id,
            namespace,
            updated_at: updatedAt
        })

        return result.changes === 1
    } catch {
        return false
    }
}

export function getSession(db: Database, id: string): StoredSession | null {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as DbSessionRow | undefined
    return row ? toStoredSession(row) : null
}

export function getSessionByNamespace(db: Database, id: string, namespace: string): StoredSession | null {
    const row = db.prepare(
        'SELECT * FROM sessions WHERE id = ? AND namespace = ?'
    ).get(id, namespace) as DbSessionRow | undefined
    return row ? toStoredSession(row) : null
}

export function getSessions(db: Database): StoredSession[] {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as DbSessionRow[]
    return rows.map(toStoredSession)
}

export function getSessionsByNamespace(db: Database, namespace: string): StoredSession[] {
    const rows = db.prepare(
        'SELECT * FROM sessions WHERE namespace = ? ORDER BY updated_at DESC'
    ).all(namespace) as DbSessionRow[]
    return rows.map(toStoredSession)
}

export function deleteSession(db: Database, id: string, namespace: string): boolean {
    const result = db.prepare(
        'DELETE FROM sessions WHERE id = ? AND namespace = ?'
    ).run(id, namespace)
    return result.changes > 0
}

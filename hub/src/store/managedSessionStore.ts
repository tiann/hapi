import type { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import {
    AGENT_FLAVORS,
    CODEX_SERVICE_TIERS,
    PERMISSION_MODES,
    type AgentFlavor,
    type ManagedSessionOutcomeAck,
    type ManagedSessionOutcomeRequest
} from '@hapi/protocol'
import type { CodexServiceTier, PermissionMode } from '@hapi/protocol/types'
import { validateActivityEventTime } from '../utils/activityEventTime'

export type ManagedResumeSpawnOptions = {
    directory: string
    agent: AgentFlavor
    model?: string
    modelReasoningEffort?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
    resumeSessionId: string
    effort?: string
    permissionMode?: PermissionMode
    serviceTier?: CodexServiceTier
}

export type ManagedResumeOperation = {
    version: 1
    machineId: string
    spawnOptions: ManagedResumeSpawnOptions
}

type SessionRow = {
    id: string
    namespace: string
    machine_id: string | null
    metadata: string | null
    metadata_version: number
    active: number
}

function parseMetadata(value: string | null): Record<string, unknown> {
    if (!value) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
        return {}
    }
}

function requestHash(request: ManagedSessionOutcomeRequest): string {
    const { expectedVersion: _serverDerivedVersion, ...stable } = request
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function parseManagedResumeOperation(value: string | null): ManagedResumeOperation | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        const operation = parsed as Record<string, unknown>
        if (operation.version !== 1 || typeof operation.machineId !== 'string' || !operation.machineId.trim()) return null
        if (!operation.spawnOptions || typeof operation.spawnOptions !== 'object' || Array.isArray(operation.spawnOptions)) return null
        const spawnOptions = operation.spawnOptions as Record<string, unknown>
        if (typeof spawnOptions.directory !== 'string' || !spawnOptions.directory) return null
        if (typeof spawnOptions.agent !== 'string' || !(AGENT_FLAVORS as readonly string[]).includes(spawnOptions.agent)) return null
        if (typeof spawnOptions.resumeSessionId !== 'string' || !spawnOptions.resumeSessionId) return null
        for (const key of ['model', 'modelReasoningEffort', 'worktreeName', 'effort'] as const) {
            if (spawnOptions[key] !== undefined && typeof spawnOptions[key] !== 'string') return null
        }
        if (spawnOptions.yolo !== undefined && typeof spawnOptions.yolo !== 'boolean') return null
        if (spawnOptions.sessionType !== undefined && spawnOptions.sessionType !== 'simple' && spawnOptions.sessionType !== 'worktree') return null
        if (spawnOptions.permissionMode !== undefined && (
            typeof spawnOptions.permissionMode !== 'string'
            || !(PERMISSION_MODES as readonly string[]).includes(spawnOptions.permissionMode)
        )) return null
        if (spawnOptions.serviceTier !== undefined && (
            typeof spawnOptions.serviceTier !== 'string'
            || !(CODEX_SERVICE_TIERS as readonly string[]).includes(spawnOptions.serviceTier)
        )) return null
        return {
            version: 1,
            machineId: operation.machineId,
            spawnOptions: {
                directory: spawnOptions.directory,
                agent: spawnOptions.agent as AgentFlavor,
                ...(spawnOptions.model !== undefined ? { model: spawnOptions.model as string } : {}),
                ...(spawnOptions.modelReasoningEffort !== undefined ? { modelReasoningEffort: spawnOptions.modelReasoningEffort as string } : {}),
                ...(spawnOptions.yolo !== undefined ? { yolo: spawnOptions.yolo as boolean } : {}),
                ...(spawnOptions.sessionType !== undefined ? { sessionType: spawnOptions.sessionType as 'simple' | 'worktree' } : {}),
                ...(spawnOptions.worktreeName !== undefined ? { worktreeName: spawnOptions.worktreeName as string } : {}),
                resumeSessionId: spawnOptions.resumeSessionId,
                ...(spawnOptions.effort !== undefined ? { effort: spawnOptions.effort as string } : {}),
                ...(spawnOptions.permissionMode !== undefined ? { permissionMode: spawnOptions.permissionMode as PermissionMode } : {}),
                ...(spawnOptions.serviceTier !== undefined ? { serviceTier: spawnOptions.serviceTier as CodexServiceTier } : {})
            }
        }
    } catch {
        return null
    }
}

function serializeManagedResumeOperation(operation: ManagedResumeOperation): string {
    const normalized = parseManagedResumeOperation(JSON.stringify(operation))
    if (!normalized) throw new Error('managed resume operation is invalid')
    return JSON.stringify(normalized)
}

export class ManagedSessionStore {
    constructor(private readonly db: Database) {}

    resolveCanonical(namespace: string, sessionId: string): string {
        let current = sessionId
        const seen = new Set<string>()
        for (let depth = 0; depth < 32; depth += 1) {
            if (seen.has(current)) throw new Error('session alias cycle detected')
            seen.add(current)
            const row = this.db.prepare(
                'SELECT canonical_session_id FROM session_aliases WHERE namespace = ? AND alias_id = ?'
            ).get(namespace, current) as { canonical_session_id: string } | undefined
            if (!row) return current
            current = row.canonical_session_id
        }
        throw new Error('session alias chain exceeds limit')
    }

    addAlias(namespace: string, aliasId: string, canonicalSessionId: string): void {
        this.db.transaction(() => this.addAliasRows(namespace, aliasId, canonicalSessionId))()
    }

    addAliasInTransaction(namespace: string, aliasId: string, canonicalSessionId: string): void {
        this.addAliasRows(namespace, aliasId, canonicalSessionId)
    }

    private addAliasRows(namespace: string, aliasId: string, canonicalSessionId: string): void {
        const canonical = this.resolveCanonical(namespace, canonicalSessionId)
        if (aliasId === canonical) return
        if (this.resolveCanonical(namespace, canonical) === aliasId) throw new Error('session alias would create a cycle')
        this.db.prepare(`
            UPDATE delivery_attempts SET canonical_session_id = ?
            WHERE namespace = ? AND canonical_session_id = ?
        `).run(canonical, namespace, aliasId)
        this.db.prepare(`
            UPDATE session_aliases SET canonical_session_id = ?
            WHERE namespace = ? AND canonical_session_id = ?
        `).run(canonical, namespace, aliasId)
        this.db.prepare(`
            INSERT INTO session_aliases(namespace, alias_id, canonical_session_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(namespace, alias_id) DO UPDATE SET canonical_session_id = excluded.canonical_session_id
        `).run(namespace, aliasId, canonical, Date.now())
    }

    markOutcome(request: ManagedSessionOutcomeRequest): ManagedSessionOutcomeAck {
        if (!request.sessionId) return { result: 'deferred', launchNonce: request.launchNonce }
        const transaction = this.db.transaction((): ManagedSessionOutcomeAck => {
            const hash = requestHash(request)
            const replay = this.db.prepare(`
                SELECT request_hash, response_json FROM managed_outcome_idempotency
                WHERE namespace = ? AND machine_id = ? AND idempotency_key = ?
            `).get(request.namespace, request.machineId, request.idempotencyKey) as { request_hash: string; response_json: string } | undefined
            if (replay) {
                return replay.request_hash === hash
                    ? JSON.parse(replay.response_json) as ManagedSessionOutcomeAck
                    : { result: 'error', reason: 'launch-mismatch' }
            }
            if (validateActivityEventTime(request.lifecycleStateSince, Date.now(), { allowHistorical: true }) === null) {
                return { result: 'error', reason: 'invalid-request' }
            }

            const canonicalSessionId = this.resolveCanonical(request.namespace, request.sessionId!)
            const row = this.db.prepare('SELECT id, namespace, machine_id, metadata, metadata_version, active FROM sessions WHERE id = ? AND namespace = ?')
                .get(canonicalSessionId, request.namespace) as SessionRow | undefined
            if (!row) return { result: 'error', reason: 'not-found' }
            const metadata = parseMetadata(row.metadata)
            const boundMachine = row.machine_id ?? (typeof metadata.machineId === 'string' ? metadata.machineId : null)
            if (boundMachine !== request.machineId
                || metadata.launchNonce !== request.launchNonce
                || metadata.runnerInstanceId !== request.runnerInstanceId) {
                return { result: 'error', reason: 'launch-mismatch' }
            }
            if (request.expectedVersion === null || request.expectedVersion !== row.metadata_version) {
                return { result: 'error', reason: 'version-mismatch' }
            }

            const next = { ...metadata }
            const preserveArchive = metadata.lifecycleState === 'archived' && request.lifecycleState !== 'running'
            if (!preserveArchive) {
                next.lifecycleState = request.lifecycleState
                next.lifecycleStateSince = request.lifecycleStateSince
                if (request.lifecycleState === 'running') {
                    delete next.stoppedBy
                    delete next.stopReasonCode
                } else {
                    if (request.stoppedBy) next.stoppedBy = request.stoppedBy
                    if (request.stopReasonCode) next.stopReasonCode = request.stopReasonCode
                }
            }
            const version = row.metadata_version + 1
            const active = request.lifecycleState === 'running' && !preserveArchive
            const activityAt = Date.now()
            // Lifecycle metadata and active state share one event clock. If the
            // activity CAS rejects a stale outcome, keep the newer lifecycle too.
            this.db.prepare(`
                UPDATE sessions SET
                    metadata = CASE WHEN @apply_activity = 1 AND (
                        activity_event_at IS NULL
                        OR activity_event_at < @activity_event_at
                        OR (activity_event_at = @activity_event_at AND (@active = 0 OR active != 0))
                    ) THEN @metadata ELSE metadata END,
                    metadata_version = @metadata_version,
                    active = CASE WHEN @apply_activity = 1 AND (
                        activity_event_at IS NULL
                        OR activity_event_at < @activity_event_at
                        OR (activity_event_at = @activity_event_at AND @active = 0 AND active != 0)
                    ) THEN @active ELSE active END,
                    active_at = CASE WHEN @apply_activity = 1 AND (
                        activity_event_at IS NULL
                        OR activity_event_at < @activity_event_at
                        OR (activity_event_at = @activity_event_at AND @active = 0 AND active != 0)
                    ) THEN @active_at ELSE active_at END,
                    activity_event_at = CASE WHEN @apply_activity = 1 AND (
                        activity_event_at IS NULL
                        OR activity_event_at < @activity_event_at
                        OR (activity_event_at = @activity_event_at AND @active = 0 AND active != 0)
                    ) THEN @activity_event_at ELSE activity_event_at END,
                    updated_at = @updated_at,
                    seq = seq + 1
                WHERE id = @id AND namespace = @namespace AND metadata_version = @expected_version
            `).run({
                metadata: JSON.stringify(next),
                metadata_version: version,
                apply_activity: preserveArchive ? 0 : 1,
                active: active ? 1 : 0,
                active_at: activityAt,
                activity_event_at: request.lifecycleStateSince,
                updated_at: activityAt,
                id: canonicalSessionId,
                namespace: request.namespace,
                expected_version: row.metadata_version
            })

            const response: ManagedSessionOutcomeAck = { result: 'success', canonicalSessionId, version }
            this.db.prepare(`
                INSERT INTO managed_outcome_idempotency(namespace, machine_id, idempotency_key, request_hash, response_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(request.namespace, request.machineId, request.idempotencyKey, hash, JSON.stringify(response), Date.now())
            return response
        })
        return transaction()
    }

    tryAcquireResumeLease(
        namespace: string,
        sessionId: string,
        ownerToken: string,
        ttlMs: number,
        proposedSpawnRequestId: string
    ): { status: 'acquired'; spawnRequestId: string; reusedSpawnRequestId: boolean; resumeOperation: ManagedResumeOperation | null } | { status: 'waiting' } | { status: 'ambiguous' } | { status: 'complete'; resultSessionId: string } {
        const canonical = sessionId
        const now = Date.now()
        const transaction = this.db.transaction(() => {
            const current = this.db.prepare(`
                SELECT owner_token, expires_at, status, result_session_id, spawn_request_id, spawn_operation_json FROM managed_resume_singleflight
                WHERE namespace = ? AND canonical_session_id = ?
            `).get(namespace, canonical) as {
                owner_token: string
                expires_at: number
                status: string
                result_session_id: string | null
                spawn_request_id: string | null
                spawn_operation_json: string | null
            } | undefined
            if (current?.status === 'complete' && current.result_session_id && current.expires_at > now) {
                return { status: 'complete' as const, resultSessionId: current.result_session_id }
            }
            if (current?.status === 'legacy_ambiguous') return { status: 'ambiguous' as const }
            if (current && current.expires_at > now && current.owner_token !== ownerToken) return { status: 'waiting' as const }
            const existingResumeOperation = current?.status === 'running'
                ? parseManagedResumeOperation(current.spawn_operation_json)
                : null
            if (current?.status === 'running' && (current.spawn_request_id === null || existingResumeOperation === null)) {
                const quarantined = this.db.prepare(`
                    UPDATE managed_resume_singleflight
                    SET status = 'legacy_ambiguous', updated_at = ?
                    WHERE namespace = ? AND canonical_session_id = ?
                      AND status = 'running'
                `).run(now, namespace, canonical)
                if (quarantined.changes !== 1) {
                    throw new Error('failed to quarantine legacy ambiguous resume lease')
                }
                return { status: 'ambiguous' as const }
            }
            const existingSpawnRequestId = current?.status === 'running'
                ? current.spawn_request_id
                : null
            const reusedSpawnRequestId = existingSpawnRequestId !== null
            const spawnRequestId = existingSpawnRequestId ?? proposedSpawnRequestId
            this.db.prepare(`
                INSERT INTO managed_resume_singleflight(
                    namespace, canonical_session_id, owner_token, expires_at,
                    status, result_session_id, spawn_request_id, spawn_operation_json, updated_at
                )
                VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?)
                ON CONFLICT(namespace, canonical_session_id) DO UPDATE SET
                    owner_token = excluded.owner_token, expires_at = excluded.expires_at,
                    status = 'running', result_session_id = NULL,
                    spawn_request_id = excluded.spawn_request_id,
                    spawn_operation_json = excluded.spawn_operation_json,
                    updated_at = excluded.updated_at
            `).run(
                namespace,
                canonical,
                ownerToken,
                now + ttlMs,
                spawnRequestId,
                existingResumeOperation ? serializeManagedResumeOperation(existingResumeOperation) : null,
                now
            )
            return {
                status: 'acquired' as const,
                spawnRequestId,
                reusedSpawnRequestId,
                resumeOperation: existingResumeOperation
            }
        })
        return transaction()
    }

    bindResumeLeaseOperation(
        namespace: string,
        sessionId: string,
        ownerToken: string,
        spawnRequestId: string,
        operation: ManagedResumeOperation
    ): ManagedResumeOperation {
        const serialized = serializeManagedResumeOperation(operation)
        const normalized = parseManagedResumeOperation(serialized)!
        const result = this.db.prepare(`
            UPDATE managed_resume_singleflight
            SET spawn_operation_json = ?, updated_at = ?
            WHERE namespace = ? AND canonical_session_id = ?
              AND owner_token = ? AND status = 'running'
              AND spawn_request_id = ? AND spawn_operation_json IS NULL
        `).run(serialized, Date.now(), namespace, sessionId, ownerToken, spawnRequestId)
        if (result.changes === 1) return normalized

        const existing = this.db.prepare(`
            SELECT spawn_operation_json FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
              AND owner_token = ? AND status = 'running' AND spawn_request_id = ?
        `).get(namespace, sessionId, ownerToken, spawnRequestId) as { spawn_operation_json: string | null } | undefined
        const parsed = parseManagedResumeOperation(existing?.spawn_operation_json ?? null)
        if (parsed && JSON.stringify(parsed) === JSON.stringify(normalized)) return parsed
        throw new Error('managed resume lease operation binding mismatch')
    }

    completeResumeLease(namespace: string, sessionId: string, ownerToken: string, resultSessionId: string): void {
        const canonical = sessionId
        const transaction = this.db.transaction(() => {
            this.addAliasRows(namespace, canonical, resultSessionId)
            const result = this.db.prepare(`
                UPDATE managed_resume_singleflight SET status = 'complete', result_session_id = ?, expires_at = ?, updated_at = ?
                WHERE namespace = ? AND canonical_session_id = ? AND owner_token = ?
            `).run(resultSessionId, Date.now() + 60_000, Date.now(), namespace, canonical, ownerToken)
            if (result.changes !== 1) throw new Error('resume lease owner mismatch')
        })
        transaction()
    }

    renewResumeLease(namespace: string, sessionId: string, ownerToken: string, ttlMs: number): boolean {
        const now = Date.now()
        const result = this.db.prepare(`
            UPDATE managed_resume_singleflight SET expires_at = ?, updated_at = ?
            WHERE namespace = ? AND canonical_session_id = ? AND owner_token = ? AND status = 'running'
        `).run(now + ttlMs, now, namespace, sessionId, ownerToken)
        return result.changes === 1
    }

    releaseResumeLease(namespace: string, sessionId: string, ownerToken: string): void {
        const canonical = sessionId
        this.db.prepare(`
            DELETE FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ? AND owner_token = ? AND status = 'running'
        `).run(namespace, canonical, ownerToken)
    }

    abandonResumeLease(namespace: string, sessionId: string, ownerToken: string): boolean {
        const result = this.db.prepare(`
            UPDATE managed_resume_singleflight
            SET owner_token = ?, expires_at = 0, updated_at = ?
            WHERE namespace = ? AND canonical_session_id = ? AND owner_token = ? AND status = 'running'
        `).run(`abandoned:${randomUUID()}`, Date.now(), namespace, sessionId, ownerToken)
        return result.changes === 1
    }

    newLeaseToken(): string {
        return randomUUID()
    }
}

import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import type { ManagedResumeOperation } from './managedSessionStore'

let sessionCounter = 0
const activityBase = Date.now()
function createSession(store: Store, overrides: Record<string, unknown> = {}) {
    return store.sessions.getOrCreateSession(`tag-${++sessionCounter}`, {
        path: '/tmp', host: 'host', machineId: 'machine-1',
        launchNonce: 'launch-1', runnerInstanceId: 'runner-1', lifecycleState: 'running',
        ...overrides
    }, null, 'default')
}

function createResumeOperation(overrides: Partial<ManagedResumeOperation> = {}): ManagedResumeOperation {
    return {
        version: 1,
        machineId: 'machine-1',
        spawnOptions: {
            directory: '/tmp/project',
            agent: 'claude',
            yolo: false,
            sessionType: 'simple',
            resumeSessionId: 'claude-session-1'
        },
        ...overrides
    }
}

describe('ManagedSessionStore', () => {
    it('resolves aliases and atomically applies a bound managed outcome', () => {
        const store = new Store(':memory:')
        const session = createSession(store)
        store.managedSessions.addAlias('default', 'old-session', session.id)

        const result = store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: 'old-session', launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'outcome-1',
            lifecycleState: 'stopped', active: false, stoppedBy: 'runner-recycle',
            stopReasonCode: 'runner-recycle', lifecycleStateSince: activityBase + 123
        })

        expect(result).toEqual({ result: 'success', canonicalSessionId: session.id, version: 2 })
        expect(store.sessions.getSession(session.id)).toMatchObject({ active: false, metadataVersion: 2 })
        expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({
            lifecycleState: 'stopped', stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle'
        })
    })

    it('replays idempotent results and rejects launch, machine, and version conflicts', () => {
        const store = new Store(':memory:')
        const session = createSession(store)
        const base = {
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'outcome-1',
            lifecycleState: 'unhealthy' as const, active: false, stopReasonCode: 'ambiguous-turn-delivery' as const,
            lifecycleStateSince: activityBase + 123
        }
        const first = store.managedSessions.markOutcome(base)
        expect(store.managedSessions.markOutcome(base)).toEqual(first)
        expect(store.managedSessions.markOutcome({ ...base, idempotencyKey: 'bad-launch', launchNonce: 'other' })).toEqual({ result: 'error', reason: 'launch-mismatch' })
        expect(store.managedSessions.markOutcome({ ...base, idempotencyKey: 'bad-machine', machineId: 'other' })).toEqual({ result: 'error', reason: 'launch-mismatch' })
        expect(store.managedSessions.markOutcome({ ...base, idempotencyKey: 'bad-version', expectedVersion: 1 })).toEqual({ result: 'error', reason: 'version-mismatch' })
    })

    it('defers missing session IDs, preserves archives, and clears stop fields on running', () => {
        const store = new Store(':memory:')
        expect(store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: null, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: null, idempotencyKey: 'deferred',
            lifecycleState: 'stopped', active: false, lifecycleStateSince: activityBase + 1
        })).toEqual({ result: 'deferred', launchNonce: 'launch-1' })

        const archived = createSession(store, { lifecycleState: 'archived', archivedBy: 'cli', archiveReason: 'user' })
        store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: archived.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'preserve',
            lifecycleState: 'stopped', active: false, lifecycleStateSince: activityBase + 2
        })
        expect(store.sessions.getSession(archived.id)?.metadata).toMatchObject({ lifecycleState: 'archived', archiveReason: 'user' })

        const stopped = createSession(store, { stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle' })
        store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: stopped.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'resume',
            lifecycleState: 'running', active: true, lifecycleStateSince: activityBase + 3
        })
        const metadata = store.sessions.getSession(stopped.id)?.metadata as Record<string, unknown>
        expect(metadata.lifecycleState).toBe('running')
        expect(metadata.stoppedBy).toBeUndefined()
        expect(metadata.stopReasonCode).toBeUndefined()
        expect(store.sessions.getSession(stopped.id)?.active).toBe(true)
    })

    it('replays the same outcome idempotency key when only the server-derived version changed', () => {
        const store = new Store(':memory:')
        const session = createSession(store)
        const request = {
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'retry-version',
            lifecycleState: 'stopped' as const, active: false, lifecycleStateSince: activityBase + 5
        }
        const first = store.managedSessions.markOutcome(request)
        expect(store.managedSessions.markOutcome({ ...request, expectedVersion: 2 })).toEqual(first)
    })

    it('does not let a stale managed running outcome bypass an activity tombstone', () => {
        const store = new Store(':memory:')
        const session = createSession(store)
        expect(store.sessions.setSessionActivity(session.id, false, activityBase + 200, activityBase + 200, 'default')).toBe(true)

        expect(store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'stale-running',
            lifecycleState: 'running', active: true, lifecycleStateSince: activityBase + 199
        })).toMatchObject({ result: 'success' })

        expect(store.sessions.getSession(session.id)).toMatchObject({
            active: false,
            activityEventAt: activityBase + 200,
            metadataVersion: 2
        })
    })

    it('keeps terminal lifecycle metadata when a stale managed running outcome loses activity CAS', () => {
        const store = new Store(':memory:')
        const session = createSession(store)
        expect(store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'newer-stop',
            lifecycleState: 'stopped', active: false, lifecycleStateSince: activityBase + 300,
            stoppedBy: 'runner-recycle', stopReasonCode: 'runner-recycle'
        })).toMatchObject({ result: 'success', version: 2 })

        expect(store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 2, idempotencyKey: 'stale-running-after-stop',
            lifecycleState: 'running', active: true, lifecycleStateSince: activityBase + 299
        })).toMatchObject({ result: 'success', version: 3 })

        expect(store.sessions.getSession(session.id)).toMatchObject({
            active: false,
            activityEventAt: activityBase + 300,
            metadataVersion: 3,
            metadata: expect.objectContaining({
                lifecycleState: 'stopped',
                stoppedBy: 'runner-recycle',
                stopReasonCode: 'runner-recycle'
            })
        })
    })

    it('rejects a managed activity time outside the shared clock-skew window', () => {
        const store = new Store(':memory:')
        const session = createSession(store)

        expect(store.managedSessions.markOutcome({
            namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
            runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'future-stop',
            lifecycleState: 'stopped', active: false, lifecycleStateSince: Date.now() + 60 * 60_000
        })).toEqual({ result: 'error', reason: 'invalid-request' })

        expect(store.sessions.getSession(session.id)).toMatchObject({
            active: false,
            activityEventAt: null,
            metadataVersion: 1
        })
    })

    it('allows historical durable outcomes and replays them idempotently after the live time window', () => {
        const originalDateNow = Date.now
        let now = activityBase + 1_000
        Date.now = () => now
        try {
            const store = new Store(':memory:')
            const session = createSession(store)
            const request = {
                namespace: 'default', machineId: 'machine-1', sessionId: session.id, launchNonce: 'launch-1',
                runnerInstanceId: 'runner-1', expectedVersion: 1, idempotencyKey: 'historical-stop',
                lifecycleState: 'stopped' as const, active: false, lifecycleStateSince: now - 11 * 60_000
            }

            const first = store.managedSessions.markOutcome(request)
            expect(first).toMatchObject({ result: 'success' })
            now += 11 * 60_000
            expect(store.managedSessions.markOutcome({ ...request, expectedVersion: 2 })).toEqual(first)
        } finally {
            Date.now = originalDateNow
        }
    })

    it('moves delivery history with an alias and rolls back both changes on a collision', () => {
        const store = new Store(':memory:')
        const canonical = createSession(store)
        const base = { namespace: 'default', messageId: 'message-1', attemptId: 'attempt-1', launchNonce: 'launch-1', sequence: 1, state: 'prepared' as const, createdAt: 1 }
        store.deliveryAttempts.append({ ...base, canonicalSessionId: 'alias-ok', idempotencyKey: 'alias-ok-ledger' })
        store.managedSessions.addAlias('default', 'alias-ok', canonical.id)
        expect(store.deliveryAttempts.recoverable('default', canonical.id)).toHaveLength(1)

        store.deliveryAttempts.append({ ...base, canonicalSessionId: canonical.id, idempotencyKey: 'canonical-collision' })
        store.deliveryAttempts.append({ ...base, canonicalSessionId: 'alias-collision', idempotencyKey: 'alias-collision' })
        expect(() => store.managedSessions.addAlias('default', 'alias-collision', canonical.id)).toThrow()
        expect(store.managedSessions.resolveCanonical('default', 'alias-collision')).toBe('alias-collision')
        expect(store.deliveryAttempts.recoverable('default', 'alias-collision')).toHaveLength(1)
    })

    it('atomically moves aliases, delivery history, and messages as one crash barrier', () => {
        const store = new Store(':memory:')
        const oldSession = createSession(store)
        const canonical = createSession(store)
        store.messages.addMessage(oldSession.id, { text: 'old message' }, 'old-local-id')
        store.deliveryAttempts.append({
            namespace: 'default', canonicalSessionId: oldSession.id, messageId: 'message-1',
            attemptId: 'attempt-1', launchNonce: 'launch-1', sequence: 1,
            state: 'prepared', createdAt: 1, idempotencyKey: 'old-ledger'
        })
        const db = (store as any).db
        db.exec(`
            CREATE TRIGGER fail_session_message_merge
            BEFORE UPDATE OF session_id ON messages
            WHEN OLD.session_id = '${oldSession.id}'
            BEGIN SELECT RAISE(ABORT, 'injected message merge failure'); END;
        `)

        expect(() => store.mergeSessionIdentity('default', oldSession.id, canonical.id)).toThrow('injected message merge failure')
        expect(store.managedSessions.resolveCanonical('default', oldSession.id)).toBe(oldSession.id)
        expect(store.deliveryAttempts.recoverable('default', oldSession.id)).toHaveLength(1)
        expect(store.messages.getMessages(oldSession.id)).toHaveLength(1)
        expect(store.messages.getMessages(canonical.id)).toHaveLength(0)

        db.exec('DROP TRIGGER fail_session_message_merge')
        store.mergeSessionIdentity('default', oldSession.id, canonical.id)
        expect(store.managedSessions.resolveCanonical('default', oldSession.id)).toBe(canonical.id)
        expect(store.deliveryAttempts.recoverable('default', canonical.id)).toHaveLength(1)
        expect(store.messages.getMessages(oldSession.id)).toHaveLength(0)
        expect(store.messages.getMessages(canonical.id)).toHaveLength(1)
    })

    it('rolls back delivery history when alias insertion fails after the ledger move', () => {
        const store = new Store(':memory:')
        store.deliveryAttempts.append({
            namespace: 'default', canonicalSessionId: 'orphan-alias', messageId: 'message-1',
            attemptId: 'attempt-1', launchNonce: 'launch-1', sequence: 1,
            state: 'prepared', createdAt: 1, idempotencyKey: 'orphan-ledger'
        })

        expect(() => store.managedSessions.addAlias('default', 'orphan-alias', 'missing-session')).toThrow()
        expect(store.deliveryAttempts.recoverable('default', 'orphan-alias')).toHaveLength(1)
        expect(store.deliveryAttempts.recoverable('default', 'missing-session')).toHaveLength(0)
    })

    it('preserves transitive aliases when an intermediate canonical session is deleted', () => {
        const store = new Store(':memory:')
        const intermediate = createSession(store)
        const canonical = createSession(store)

        store.managedSessions.addAlias('default', 'oldest-session', intermediate.id)
        store.managedSessions.addAlias('default', intermediate.id, canonical.id)
        expect(store.sessions.deleteSession(intermediate.id, 'default')).toBe(true)

        expect(store.managedSessions.resolveCanonical('default', 'oldest-session')).toBe(canonical.id)
    })

    it('reacquires an expired completed same-id resume lease', async () => {
        const store = new Store(':memory:')
        const first = store.managedSessions.tryAcquireResumeLease(
            'default', 'session-1', 'owner-1', 1,
            '11111111-1111-4111-8111-111111111111'
        )
        expect(first.status).toBe('acquired')
        store.managedSessions.completeResumeLease('default', 'session-1', 'owner-1', 'session-1')
        await new Promise((resolve) => setTimeout(resolve, 5))
        const row = (store.managedSessions as any).db.prepare(`
            UPDATE managed_resume_singleflight SET expires_at = ? WHERE namespace = ? AND canonical_session_id = ?
        `).run(Date.now() - 1, 'default', 'session-1')
        expect(row.changes).toBe(1)
        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'session-1', 'owner-2', 100,
            '22222222-2222-4222-8222-222222222222'
        )).toEqual({
            status: 'acquired',
            spawnRequestId: '22222222-2222-4222-8222-222222222222',
            reusedSpawnRequestId: false,
            resumeOperation: null
        })
    })

    it('preserves a bound resume operation across ambiguous lease abandonment', () => {
        const store = new Store(':memory:')
        const operation = createResumeOperation()
        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'session-ambiguous', 'owner-1', 100,
            '33333333-3333-4333-8333-333333333333'
        )).toEqual({
            status: 'acquired',
            spawnRequestId: '33333333-3333-4333-8333-333333333333',
            reusedSpawnRequestId: false,
            resumeOperation: null
        })
        expect(store.managedSessions.bindResumeLeaseOperation(
            'default',
            'session-ambiguous',
            'owner-1',
            '33333333-3333-4333-8333-333333333333',
            operation
        )).toEqual(operation)

        store.managedSessions.abandonResumeLease('default', 'session-ambiguous', 'owner-1')

        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'session-ambiguous', 'owner-2', 100,
            '44444444-4444-4444-8444-444444444444'
        )).toEqual({
            status: 'acquired',
            spawnRequestId: '33333333-3333-4333-8333-333333333333',
            reusedSpawnRequestId: true,
            resumeOperation: operation
        })
    })

    it('accepts an idempotent operation bind and rejects identity drift', () => {
        const store = new Store(':memory:')
        const spawnRequestId = '77777777-7777-4777-8777-777777777777'
        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'session-bind', 'owner-bind', 100, spawnRequestId
        ).status).toBe('acquired')

        const operation = createResumeOperation()
        expect(store.managedSessions.bindResumeLeaseOperation(
            'default', 'session-bind', 'owner-bind', spawnRequestId, operation
        )).toEqual(operation)
        expect(store.managedSessions.bindResumeLeaseOperation(
            'default', 'session-bind', 'owner-bind', spawnRequestId, operation
        )).toEqual(operation)
        expect(() => store.managedSessions.bindResumeLeaseOperation(
            'default',
            'session-bind',
            'owner-bind',
            spawnRequestId,
            createResumeOperation({ machineId: 'machine-2' })
        )).toThrow('managed resume lease operation binding mismatch')
    })

    it('refuses to mint a new request ID for a legacy ambiguous resume lease', () => {
        const store = new Store(':memory:')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            INSERT INTO managed_resume_singleflight(
                namespace, canonical_session_id, owner_token, expires_at,
                status, result_session_id, spawn_request_id, updated_at
            ) VALUES (?, ?, ?, ?, 'legacy_ambiguous', NULL, NULL, ?)
        `).run('default', 'legacy-session', 'legacy-owner', Date.now() - 1, Date.now() - 10)

        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'legacy-session', 'owner-v15', 100,
            '55555555-5555-4555-8555-555555555555'
        )).toEqual({ status: 'ambiguous' })

        expect(db.prepare(`
            SELECT owner_token, status, spawn_request_id
            FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
        `).get('default', 'legacy-session')).toEqual({
            owner_token: 'legacy-owner',
            status: 'legacy_ambiguous',
            spawn_request_id: null
        })
    })

    it('waits for a live owner before classifying its not-yet-bound operation', () => {
        const store = new Store(':memory:')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'live-unbound', 'owner-live', 60_000,
            '88888888-8888-4888-8888-888888888888'
        ).status).toBe('acquired')

        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'live-unbound', 'owner-other', 100,
            '99999999-9999-4999-8999-999999999999'
        )).toEqual({ status: 'waiting' })
        expect(db.prepare(`
            SELECT owner_token, status, spawn_request_id, spawn_operation_json
            FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
        `).get('default', 'live-unbound')).toEqual({
            owner_token: 'owner-live',
            status: 'running',
            spawn_request_id: '88888888-8888-4888-8888-888888888888',
            spawn_operation_json: null
        })
    })

    it('quarantines an expired running row without operation identity', () => {
        const store = new Store(':memory:')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            INSERT INTO managed_resume_singleflight(
                namespace, canonical_session_id, owner_token, expires_at,
                status, result_session_id, spawn_request_id, spawn_operation_json, updated_at
            ) VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL, ?)
        `).run(
            'default',
            'late-expired',
            'legacy-v16-owner',
            Date.now() - 60_000,
            '66666666-6666-4666-8666-666666666666',
            Date.now() - 60_010
        )

        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'late-expired', 'owner-v17', 100,
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        )).toEqual({ status: 'ambiguous' })
        expect(db.prepare(`
            SELECT owner_token, status, spawn_request_id, spawn_operation_json
            FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
        `).get('default', 'late-expired')).toEqual({
            owner_token: 'legacy-v16-owner',
            status: 'legacy_ambiguous',
            spawn_request_id: '66666666-6666-4666-8666-666666666666',
            spawn_operation_json: null
        })
    })

    it('quarantines an expired running row with malformed operation identity', () => {
        const store = new Store(':memory:')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            INSERT INTO managed_resume_singleflight(
                namespace, canonical_session_id, owner_token, expires_at,
                status, result_session_id, spawn_request_id, spawn_operation_json, updated_at
            ) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?)
        `).run(
            'default',
            'malformed-expired',
            'malformed-owner',
            Date.now() - 60_000,
            'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
            '{"version":1}',
            Date.now() - 60_010
        )

        expect(store.managedSessions.tryAcquireResumeLease(
            'default', 'malformed-expired', 'owner-v17', 100,
            'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd'
        )).toEqual({ status: 'ambiguous' })
        expect(db.prepare(`
            SELECT status, spawn_operation_json
            FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
        `).get('default', 'malformed-expired')).toEqual({
            status: 'legacy_ambiguous',
            spawn_operation_json: '{"version":1}'
        })
    })
})

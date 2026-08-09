import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from './index'

function getColumns(store: Store, table: string): string[] {
    const db: Database = (store as unknown as { db: Database }).db
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.map((row) => row.name)
}

describe('Store V25→V26 migration: session_jobs table', () => {
    it('fresh DB has session_jobs with expected columns', () => {
        const store = new Store(':memory:')
        const cols = getColumns(store, 'session_jobs')
        expect(cols).toContain('session_id')
        expect(cols).toContain('job_key')
        expect(cols).toContain('label')
        expect(cols).toContain('status')
        expect(cols).toContain('done')
        expect(cols).toContain('total')
        expect(cols).toContain('remaining')
        expect(cols).toContain('heartbeat_at')
        expect(cols).toContain('started_at')
        expect(cols).toContain('updated_at')
        expect(cols).toContain('run_id')
        store.close()
    })

    it('upserts, patches, deletes a job and surfaces primary running', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')

        const created = store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 100,
            unit: 'tracks'
        })
        expect(created.outcome).toBe('upserted')
        if (created.outcome !== 'upserted') throw new Error('unreachable')

        const primary = store.sessionJobs.getPrimaryRunning(session.id)
        expect(primary?.key).toBe('beets')
        expect(primary?.remaining).toBe(100)

        // Stable primary: earliest started_at wins even after a newer job heartbeats.
        store.sessionJobs.upsert(session.id, 'newer', {
            label: 'sidecar',
            status: 'running',
            remaining: 1,
            startedAt: (primary!.startedAt) + 60_000
        })
        store.sessionJobs.patch(session.id, 'newer', { remaining: 0 })
        expect(store.sessionJobs.getPrimaryRunning(session.id)?.key).toBe('beets')
        expect(store.sessionJobs.delete(session.id, 'newer')).toBe(true)

        const patched = store.sessionJobs.patch(session.id, 'beets', { remaining: 80 })
        expect(patched.outcome).toBe('patched')
        if (patched.outcome !== 'patched') throw new Error('unreachable')
        expect(patched.job.remaining).toBe(80)

        expect(store.sessionJobs.delete(session.id, 'beets')).toBe(true)
        expect(store.sessionJobs.getPrimaryRunning(session.id)).toBeNull()
        store.close()
    })

    it('refuses delete while a running job exists; cascades terminal jobs', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'job', { label: 'x', status: 'running' })
        expect(store.sessionJobs.list(session.id)).toHaveLength(1)
        expect(store.sessions.deleteSession(session.id, 'default')).toBe(false)
        expect(store.sessionJobs.list(session.id)).toHaveLength(1)

        store.sessionJobs.patch(session.id, 'job', { status: 'completed' })
        expect(store.sessions.deleteSession(session.id, 'default')).toBe(true)
        expect(store.sessionJobs.list(session.id)).toHaveLength(0)
        store.close()
    })

    it('preserves startedAt on PUT without body.startedAt; honors explicit correction', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const historical = 1_785_304_595_000

        const created = store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 10
        }, 2_000)
        expect(created.outcome).toBe('upserted')
        if (created.outcome !== 'upserted') throw new Error('unreachable')
        expect(created.job.startedAt).toBe(2_000)

        const progress = store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 9
        }, 3_000)
        expect(progress.outcome).toBe('upserted')
        if (progress.outcome !== 'upserted') throw new Error('unreachable')
        expect(progress.job.startedAt).toBe(2_000)
        expect(progress.job.remaining).toBe(9)

        const corrected = store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            remaining: 9,
            startedAt: historical
        }, 4_000)
        expect(corrected.outcome).toBe('upserted')
        if (corrected.outcome !== 'upserted') throw new Error('unreachable')
        expect(corrected.job.startedAt).toBe(historical)

        const patched = store.sessionJobs.patch(session.id, 'beets', { remaining: 8 }, 5_000)
        expect(patched.outcome).toBe('patched')
        if (patched.outcome !== 'patched') throw new Error('unreachable')
        expect(patched.job.startedAt).toBe(historical)
        expect(patched.job.remaining).toBe(8)

        const ownedRunId = store.sessionJobs.get(session.id, 'beets')!.runId!
        expect(ownedRunId).toBeTruthy()

        // Stale supervisor fence: wrong expectedRunId must not mutate the row.
        const stale = store.sessionJobs.patch(
            session.id,
            'beets',
            { status: 'completed', expectedRunId: 'stale-run-id' },
            6_000
        )
        expect(stale.outcome).toBe('run-mismatch')
        expect(store.sessionJobs.get(session.id, 'beets')?.status).toBe('running')

        const owned = store.sessionJobs.patch(
            session.id,
            'beets',
            { status: 'completed', expectedRunId: ownedRunId },
            7_000
        )
        expect(owned.outcome).toBe('patched')
        if (owned.outcome !== 'patched') throw new Error('unreachable')
        expect(owned.job.status).toBe('completed')
        store.close()
    })

    it('mints distinct runIds even when startedAt collides', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        const a = store.sessionJobs.upsert(session.id, 'drain', {
            label: 'a',
            status: 'running',
            startedAt: 1_000,
            runId: 'run-a'
        }, 1_000)
        expect(a.outcome).toBe('upserted')
        const b = store.sessionJobs.upsert(session.id, 'drain', {
            label: 'b',
            status: 'running',
            startedAt: 1_000,
            runId: 'run-b'
        }, 1_001)
        expect(b.outcome).toBe('upserted')
        if (b.outcome !== 'upserted') throw new Error('unreachable')
        expect(b.job.runId).toBe('run-b')
        expect(b.job.startedAt).toBe(1_000)

        const stale = store.sessionJobs.patch(session.id, 'drain', {
            status: 'completed',
            expectedRunId: 'run-a'
        }, 1_002)
        expect(stale.outcome).toBe('run-mismatch')
        expect(store.sessionJobs.get(session.id, 'drain')?.status).toBe('running')
        store.close()
    })

    it('transfers jobs on merge without colliding keys', () => {
        const store = new Store(':memory:')
        const oldSession = store.sessions.getOrCreateSession('old', { path: '/a' }, null, 'default')
        const newSession = store.sessions.getOrCreateSession('new', { path: '/b' }, null, 'default')
        store.sessionJobs.upsert(oldSession.id, 'beets', {
            label: 'beets',
            status: 'running',
            remaining: 5
        })
        const result = store.sessionJobs.transfer(oldSession.id, newSession.id)
        expect(result.moved).toBe(1)
        expect(store.sessionJobs.getPrimaryRunning(newSession.id)?.remaining).toBe(5)
        expect(store.sessionJobs.list(oldSession.id)).toHaveLength(0)
        store.close()
    })
})

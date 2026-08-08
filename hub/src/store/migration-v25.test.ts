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

        const patched = store.sessionJobs.patch(session.id, 'beets', { remaining: 80 })
        expect(patched?.remaining).toBe(80)

        expect(store.sessionJobs.delete(session.id, 'beets')).toBe(true)
        expect(store.sessionJobs.getPrimaryRunning(session.id)).toBeNull()
        store.close()
    })

    it('cascade-deletes jobs when session is deleted', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'job', { label: 'x', status: 'running' })
        expect(store.sessionJobs.list(session.id)).toHaveLength(1)
        await store.sessions.deleteSession(session.id, 'default')
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
        expect(patched?.startedAt).toBe(historical)
        expect(patched?.remaining).toBe(8)
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

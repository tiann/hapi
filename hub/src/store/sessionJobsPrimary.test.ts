import { expect, it } from 'bun:test'
import { Store } from './index'

it('projects reporting jobs before stale records, with consistent list and live primary clocks', () => {
    const store = new Store(':memory:')
    try {
        const { id } = store.sessions.getOrCreateSession('multi', { path: '/tmp' }, null, 'default')
        const jobs = store.sessionJobs
        const now = Date.now()
        for (const [i, key] of ['stale', 'first-live', 'second-live'].entries()) {
            jobs.upsert(id, key, { label: key, status: 'running' }, [1, now - 5000, now][i])
        }
        const primary = jobs.getPrimaryRunning(id)
        expect(primary).toMatchObject({ key: 'first-live', heartbeatAt: now - 5000, latestRunningHeartbeatAt: now })
        expect(jobs.getPrimaryRunningBySessionIds([id]).get(id) ?? null).toEqual(primary)
        expect(jobs.list(id)).toHaveLength(3)
    } finally { store.close() }
})

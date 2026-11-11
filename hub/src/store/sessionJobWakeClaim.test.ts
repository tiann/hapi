import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('session job terminal wake claim (#1489)', () => {
    it('fresh DB has wake columns (v34)', () => {
        const store = new Store(':memory:')
        const cols = (store as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } })
            .db.prepare('PRAGMA table_info(session_jobs)').all().map((r) => r.name)
        expect(cols).toContain('wake_on_terminal')
        expect(cols).toContain('wake_prompt')
        expect(cols).toContain('wake_emitted_run_id')
        store.close()
    })

    it('claims wake once per runId on terminal + opt-in', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')

        const created = store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            runId: 'run-a',
            wakeOnTerminal: true,
            wakePrompt: 'Next batch please.',
            detail: 'album: 1',
        })
        expect(created.outcome).toBe('upserted')

        expect(store.sessionJobs.claimTerminalWake(session.id, 'beets')).toBeNull()

        const patched = store.sessionJobs.patch(session.id, 'beets', {
            status: 'completed',
            expectedRunId: 'run-a',
            detail: 'album: done',
        })
        expect(patched.outcome).toBe('patched')

        const first = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(first).not.toBeNull()
        expect(first?.wakeEmittedRunId).toBe('pending:run-a')
        expect(first?.wakePrompt).toBe('Next batch please.')

        const second = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(second).toBeNull()

        expect(store.sessionJobs.markTerminalWakeDelivered(session.id, 'beets', 'run-a')).toBe(true)
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBe('run-a')
        expect(store.sessionJobs.claimTerminalWake(session.id, 'beets')).toBeNull()

        // Key reuse with a new run can wake again.
        store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets import',
            status: 'running',
            runId: 'run-b',
            wakeOnTerminal: true,
        })
        store.sessionJobs.patch(session.id, 'beets', {
            status: 'failed',
            expectedRunId: 'run-b',
        })
        const third = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(third?.wakeEmittedRunId).toBe('pending:run-b')
        expect(third?.status).toBe('failed')

        store.close()
    })

    it('does not claim when wakeOnTerminal is off', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'x', {
            label: 'x',
            status: 'completed',
            runId: 'r1',
            wakeOnTerminal: false,
        })
        expect(store.sessionJobs.claimTerminalWake(session.id, 'x')).toBeNull()
        store.close()
    })

    it('release clears provisional claim so delivery can retry', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets',
            status: 'completed',
            runId: 'run-retry',
            wakeOnTerminal: true,
        })
        const claimed = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(claimed?.wakeEmittedRunId).toBe('pending:run-retry')
        expect(store.sessionJobs.claimTerminalWake(session.id, 'beets')).toBeNull()

        expect(store.sessionJobs.releaseTerminalWake(session.id, 'beets', 'run-retry')).toBe(true)
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBeUndefined()

        const reclaimed = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(reclaimed?.wakeEmittedRunId).toBe('pending:run-retry')

        // Stale release id must not wipe a newer claim.
        expect(store.sessionJobs.releaseTerminalWake(session.id, 'beets', 'run-other')).toBe(false)
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBe('pending:run-retry')
        store.close()
    })

    it('clearAbandoned recovers provisional claims after hub restart', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'beets', {
            label: 'beets',
            status: 'completed',
            runId: 'run-restart',
            wakeOnTerminal: true,
        })
        store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBe('pending:run-restart')
        expect(store.sessionJobs.claimTerminalWake(session.id, 'beets')).toBeNull()

        expect(store.sessionJobs.clearAbandonedProvisionalWakeClaims()).toBe(1)
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBeUndefined()
        const reclaimed = store.sessionJobs.claimTerminalWake(session.id, 'beets')
        expect(reclaimed?.wakeEmittedRunId).toBe('pending:run-restart')

        store.sessionJobs.markTerminalWakeDelivered(session.id, 'beets', 'run-restart')
        expect(store.sessionJobs.clearAbandonedProvisionalWakeClaims()).toBe(0)
        expect(store.sessionJobs.get(session.id, 'beets')?.wakeEmittedRunId).toBe('run-restart')
        store.close()
    })

    it('lists pending terminal wakes when claim is absent or provisional', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('test', { path: '/tmp' }, null, 'default')
        store.sessionJobs.upsert(session.id, 'open', {
            label: 'open',
            status: 'completed',
            runId: 'run-p',
            wakeOnTerminal: true,
        })
        store.sessionJobs.upsert(session.id, 'inflight', {
            label: 'inflight',
            status: 'completed',
            runId: 'run-i',
            wakeOnTerminal: true,
        })
        store.sessionJobs.claimTerminalWake(session.id, 'inflight')
        store.sessionJobs.upsert(session.id, 'done', {
            label: 'done',
            status: 'completed',
            runId: 'run-d',
            wakeOnTerminal: true,
        })
        store.sessionJobs.claimTerminalWake(session.id, 'done')
        store.sessionJobs.markTerminalWakeDelivered(session.id, 'done', 'run-d')
        store.sessionJobs.upsert(session.id, 'off', {
            label: 'off',
            status: 'completed',
            runId: 'run-o',
            wakeOnTerminal: false,
        })

        const pending = store.sessionJobs.listPendingTerminalWakes()
        expect(pending.map((j) => j.key).sort()).toEqual(['inflight', 'open'])
        store.close()
    })
})

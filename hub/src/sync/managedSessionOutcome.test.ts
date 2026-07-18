import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import type { ManagedResumeOperation } from '../store/managedSessionStore'
import { ManagedSessionOutcomeService } from './managedSessionOutcome'

const resumeOperation: ManagedResumeOperation = {
    version: 1,
    machineId: 'machine-1',
    spawnOptions: {
        directory: '/tmp',
        agent: 'claude',
        yolo: false,
        sessionType: 'simple',
        resumeSessionId: 'claude-session-1'
    }
}

describe('ManagedSessionOutcomeService', () => {
    it('singleflights concurrent native resume and publishes the alias before releasing callers', async () => {
        const store = new Store(':memory:')
        const original = store.sessions.getOrCreateSession('original', { path: '/tmp', host: 'h' }, null, 'default')
        const resumed = store.sessions.getOrCreateSession('resumed', { path: '/tmp', host: 'h' }, null, 'default')
        const service = new ManagedSessionOutcomeService(store.managedSessions)
        const secondWorker = new ManagedSessionOutcomeService(store.managedSessions)
        let calls = 0
        const resume = async () => {
            calls += 1
            await new Promise((resolve) => setTimeout(resolve, 20))
            return resumed.id
        }

        const [first, second] = await Promise.all([
            service.resumeCanonical('default', original.id, resume),
            secondWorker.resumeCanonical('default', original.id, resume)
        ])

        expect(calls).toBe(1)
        expect(first).toBe(resumed.id)
        expect(second).toBe(resumed.id)
        expect(store.managedSessions.resolveCanonical('default', original.id)).toBe(resumed.id)
    })

    it('renews and fences a slow cross-worker native resume lease', async () => {
        const store = new Store(':memory:')
        const original = store.sessions.getOrCreateSession('original-slow', { path: '/tmp', host: 'h' }, null, 'default')
        const resumed = store.sessions.getOrCreateSession('resumed-slow', { path: '/tmp', host: 'h' }, null, 'default')
        const firstWorker = new ManagedSessionOutcomeService(store.managedSessions, 30)
        const secondWorker = new ManagedSessionOutcomeService(store.managedSessions, 30)
        let calls = 0
        const slowResume = async () => {
            calls += 1
            await new Promise((resolve) => setTimeout(resolve, 80))
            return resumed.id
        }
        const first = firstWorker.resumeCanonical('default', original.id, slowResume)
        await new Promise((resolve) => setTimeout(resolve, 40))
        const second = secondWorker.resumeCanonical('default', original.id, slowResume)

        expect(await first).toBe(resumed.id)
        expect(await second).toBe(resumed.id)
        expect(calls).toBe(1)
    })

    it('reuses one spawn request after an ambiguous native resume failure', async () => {
        const store = new Store(':memory:')
        const original = store.sessions.getOrCreateSession('original-ambiguous', { path: '/tmp', host: 'h' }, null, 'default')
        const resumed = store.sessions.getOrCreateSession('resumed-ambiguous', { path: '/tmp', host: 'h' }, null, 'default')
        const service = new ManagedSessionOutcomeService(store.managedSessions)
        const spawnRequestIds: string[] = []
        const ambiguous = Object.assign(new Error('resume acknowledgement is ambiguous'), {
            preserveSpawnRequest: true
        })

        await expect(service.resumeCanonical('default', original.id, async (spawnRequestId, context) => {
            spawnRequestIds.push(spawnRequestId)
            expect(context.resumeOperation).toBeNull()
            expect(context.bindResumeOperation(resumeOperation)).toEqual(resumeOperation)
            throw ambiguous
        })).rejects.toThrow('resume acknowledgement is ambiguous')

        await expect(service.resumeCanonical('default', original.id, async (spawnRequestId, context) => {
            spawnRequestIds.push(spawnRequestId)
            expect(context.resumeOperation).toEqual(resumeOperation)
            return resumed.id
        })).resolves.toBe(resumed.id)

        expect(spawnRequestIds).toHaveLength(2)
        expect(spawnRequestIds[0]).toMatch(/^[0-9a-f-]{36}$/)
        expect(spawnRequestIds[1]).toBe(spawnRequestIds[0])
    })

    it('does not invoke resume when a legacy in-flight request has no durable ID', async () => {
        const store = new Store(':memory:')
        const original = store.sessions.getOrCreateSession('legacy-original', { path: '/tmp', host: 'h' }, null, 'default')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            INSERT INTO managed_resume_singleflight(
                namespace, canonical_session_id, owner_token, expires_at,
                status, result_session_id, spawn_request_id, updated_at
            ) VALUES (?, ?, ?, ?, 'legacy_ambiguous', NULL, NULL, ?)
        `).run('default', original.id, 'legacy-owner', Date.now() - 1, Date.now() - 10)
        const service = new ManagedSessionOutcomeService(store.managedSessions)
        let calls = 0

        await expect(service.resumeCanonical('default', original.id, async () => {
            calls += 1
            throw new Error('resume callback should not run')
        })).rejects.toThrow('Legacy in-flight resume has no durable spawn request ID')

        expect(calls).toBe(0)
    })

    it('does not invoke resume for a late running row written after the v15 migration', async () => {
        const store = new Store(':memory:')
        const original = store.sessions.getOrCreateSession('late-legacy-original', { path: '/tmp', host: 'h' }, null, 'default')
        const db = (store.managedSessions as unknown as { db: import('bun:sqlite').Database }).db
        db.prepare(`
            INSERT INTO managed_resume_singleflight(
                namespace, canonical_session_id, owner_token, expires_at,
                status, result_session_id, spawn_request_id, updated_at
            ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?)
        `).run('default', original.id, 'legacy-v14-owner', Date.now() - 1, Date.now() - 10)
        const service = new ManagedSessionOutcomeService(store.managedSessions)
        let calls = 0

        await expect(service.resumeCanonical('default', original.id, async () => {
            calls += 1
            throw new Error('resume callback should not run')
        })).rejects.toThrow('Legacy in-flight resume has no durable spawn request ID')

        expect(calls).toBe(0)
        expect(db.prepare(`
            SELECT status, spawn_request_id
            FROM managed_resume_singleflight
            WHERE namespace = ? AND canonical_session_id = ?
        `).get('default', original.id)).toEqual({
            status: 'legacy_ambiguous',
            spawn_request_id: null
        })
    })
})

import { describe, expect, it } from 'bun:test'
import { SessionReadMutationSchema, SessionReadSnapshotSchema, SessionReadUpdateSchema } from './sessionReadState'
import { SyncEventSchema } from './schemas'

describe('session read state wire contract', () => {
    it('validates snapshots and namespace-scoped SSE payloads', () => {
        const states = [{ sessionId: 'a', lastSeenAt: 100, manualUnreadAt: null, version: 1 }]
        expect(SessionReadSnapshotSchema.safeParse({ states }).success).toBe(true)
        expect(SyncEventSchema.safeParse({ type: 'session-read-state-updated', namespace: 'default', states }).success).toBe(true)
    })
    it('rejects unbounded or invalid read operations', () => {
        const mutation = { mutationId: 'test', sessionId: 'a', kind: 'seen', activityAt: 100, expectedVersion: 0 }
        for (const change of [{ activityAt: -1 }, { activityAt: Infinity }, { activityAt: 0.1 },
            { activityAt: Number.MAX_SAFE_INTEGER + 1 }, { expectedVersion: -1 }, { kind: 'reset' }, { sessionId: '' }]) {
            expect(SessionReadMutationSchema.safeParse({ ...mutation, ...change }).success).toBe(false)
        }
        expect(SessionReadUpdateSchema.safeParse({ mutations: [] }).success).toBe(false)
        expect(SessionReadUpdateSchema.safeParse({ mutations: Array(501).fill(mutation) }).success).toBe(false)
    })
})

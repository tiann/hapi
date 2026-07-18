import { describe, expect, it } from 'bun:test'
import { mergeSessionMetadata, pickPreferredExecutionControl } from './sessionMetadata'

describe('mergeSessionMetadata', () => {
    it('clears stale archive fields when an archived session is resumed as running', () => {
        const merged = mergeSessionMetadata(
            {
                path: '/tmp/project',
                lifecycleState: 'archived',
                archivedBy: 'cli',
                archiveReason: 'User terminated',
                flavor: 'agy'
            },
            {
                path: '/tmp/project',
                lifecycleState: 'running',
                lifecycleStateSince: 123,
                hostPid: 456,
                flavor: 'agy'
            }
        ) as Record<string, unknown>

        expect(merged.lifecycleState).toBe('running')
        expect(merged.lifecycleStateSince).toBe(123)
        expect(merged.hostPid).toBe(456)
        expect(merged.archivedBy).toBeUndefined()
        expect(merged.archiveReason).toBeUndefined()
    })

    it('clears stale archive fields when incoming metadata is absent but current state is running', () => {
        const merged = mergeSessionMetadata(
            {
                path: '/tmp/project',
                lifecycleState: 'running',
                archivedBy: 'cli',
                archiveReason: 'old stop reason',
                flavor: 'agy'
            },
            null
        ) as Record<string, unknown>

        expect(merged.lifecycleState).toBe('running')
        expect(merged.archivedBy).toBeUndefined()
        expect(merged.archiveReason).toBeUndefined()
    })

    it('clears stale archive fields when current metadata is absent but incoming state is running', () => {
        const merged = mergeSessionMetadata(
            null,
            {
                path: '/tmp/project',
                lifecycleState: 'running',
                archivedBy: 'cli',
                archiveReason: 'old stop reason',
                flavor: 'agy'
            }
        ) as Record<string, unknown>

        expect(merged.lifecycleState).toBe('running')
        expect(merged.archivedBy).toBeUndefined()
        expect(merged.archiveReason).toBeUndefined()
    })

    it('preserves archive fields for non-running sessions', () => {
        const merged = mergeSessionMetadata(
            {
                path: '/tmp/project',
                lifecycleState: 'running',
                flavor: 'agy'
            },
            {
                lifecycleState: 'archived',
                archivedBy: 'user',
                archiveReason: 'done'
            }
        ) as Record<string, unknown>

        expect(merged.lifecycleState).toBe('archived')
        expect(merged.archivedBy).toBe('user')
        expect(merged.archiveReason).toBe('done')
    })

    it('keeps the newest summary while clearing running archive fields', () => {
        const merged = mergeSessionMetadata(
            {
                lifecycleState: 'running',
                archivedBy: 'old',
                summary: { text: 'newer', updatedAt: 20 }
            },
            {
                lifecycleState: 'running',
                archiveReason: 'old',
                summary: { text: 'older', updatedAt: 10 }
            }
        ) as Record<string, unknown>

        expect((merged.summary as Record<string, unknown>).text).toBe('newer')
        expect(merged.archivedBy).toBeUndefined()
        expect(merged.archiveReason).toBeUndefined()
    })
})

describe('pickPreferredExecutionControl', () => {
    it('prefers higher generation', () => {
        expect(pickPreferredExecutionControl(
            { owner: 'hapi-runner', generation: 1, leaseExpiresAt: null, runnerSessionId: 'a', updatedAt: 10 },
            { owner: 'desktop-sync', generation: 2, leaseExpiresAt: null, runnerSessionId: 'b', updatedAt: 5 }
        )?.owner).toBe('desktop-sync')
    })

    it('prefers hapi-runner when generation ties', () => {
        expect(pickPreferredExecutionControl(
            { owner: 'desktop-sync', generation: 1, leaseExpiresAt: null, runnerSessionId: 'a', updatedAt: 10 },
            { owner: 'hapi-runner', generation: 1, leaseExpiresAt: null, runnerSessionId: 'b', updatedAt: 5 }
        )?.owner).toBe('hapi-runner')
    })

    it('uses lease and update times as deterministic tie breakers', () => {
        expect(pickPreferredExecutionControl(
            { owner: 'desktop-sync', generation: 1, leaseExpiresAt: 10, runnerSessionId: 'a', updatedAt: 10 },
            { owner: 'desktop-sync', generation: 1, leaseExpiresAt: 20, runnerSessionId: 'b', updatedAt: 1 }
        )?.leaseExpiresAt).toBe(20)

        expect(pickPreferredExecutionControl(
            { owner: 'desktop-sync', generation: 1, leaseExpiresAt: 20, runnerSessionId: 'a', updatedAt: 10 },
            { owner: 'desktop-sync', generation: 1, leaseExpiresAt: 20, runnerSessionId: 'b', updatedAt: 11 }
        )?.updatedAt).toBe(11)
    })
})

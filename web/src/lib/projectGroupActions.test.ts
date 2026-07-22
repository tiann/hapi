import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    getProjectGroupActionAvailability,
    isOldInactiveSession,
    isSessionArchivable,
    isSessionArchived
} from './projectGroupActions'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

const archived = (id: string) =>
    makeSession({ id, metadata: { path: '/p', lifecycleState: 'archived' } })
const running = (id: string) =>
    makeSession({ id, active: true, metadata: { path: '/p', lifecycleState: 'running' } })
const completedStub = (id: string) =>
    makeSession({ id, metadata: { path: '/p' } }) // inactive, no lifecycleState

describe('isSessionArchived', () => {
    it('is true only when lifecycleState === archived', () => {
        expect(isSessionArchived(archived('a'))).toBe(true)
        expect(isSessionArchived(running('b'))).toBe(false)
        // Inactive but never formally archived must not count as archived.
        expect(isSessionArchived(completedStub('c'))).toBe(false)
    })
})

describe('isSessionArchivable', () => {
    it('is true for active sessions', () => {
        expect(isSessionArchivable(running('a'))).toBe(true)
    })

    it('is true for split-brain rows (inactive but lifecycleState still running)', () => {
        const splitBrain = makeSession({
            id: 'sb',
            active: false,
            metadata: { path: '/p', lifecycleState: 'running' }
        })
        expect(isSessionArchivable(splitBrain)).toBe(true)
    })

    it('is false for already-archived and inactive completed stubs', () => {
        expect(isSessionArchivable(archived('a'))).toBe(false)
        expect(isSessionArchivable(completedStub('b'))).toBe(false)
    })
})

describe('getProjectGroupActionAvailability', () => {
    it('allows archive-all when any session is archivable', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([
            running('a'),
            archived('b')
        ])
        expect(canArchiveAll).toBe(true)
        // Not all archived → delete blocked.
        expect(canDelete).toBe(false)
    })

    it('allows delete when every session is inactive', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([
            archived('a'),
            completedStub('b')
        ])
        expect(canArchiveAll).toBe(false)
        expect(canDelete).toBe(true)
    })

    it('blocks delete when an active session is present', () => {
        const { canDelete } = getProjectGroupActionAvailability([
            archived('a'),
            running('b')
        ])
        expect(canDelete).toBe(false)
    })

    it('blocks delete for an empty group', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([])
        expect(canArchiveAll).toBe(false)
        expect(canDelete).toBe(false)
    })
})

describe('isOldInactiveSession', () => {
    const now = 10 * 24 * 60 * 60 * 1000

    it('matches inactive sessions at least seven days old', () => {
        expect(isOldInactiveSession(makeSession({ id: 'old', updatedAt: now - 7 * 24 * 60 * 60 * 1000 }), now)).toBe(true)
    })

    it('rejects recent inactive sessions and old active sessions', () => {
        expect(isOldInactiveSession(makeSession({ id: 'recent', updatedAt: now - 6 * 24 * 60 * 60 * 1000 }), now)).toBe(false)
        expect(isOldInactiveSession(makeSession({ id: 'active', active: true, updatedAt: 0 }), now)).toBe(false)
    })
})

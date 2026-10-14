import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@hapi/protocol/types'
import {
    getProjectGroupActionAvailability,
    isSessionArchivable,
    isSessionArchived,
} from './projectGroupActions'

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
    return {
        id: 'session-1',
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentStateVersion: 1,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides,
    }
}

function archived(id: string): SessionSummary {
    return makeSession({
        id,
        active: false,
        metadata: { path: '/p', lifecycleState: 'archived' }
    })
}

function running(id: string): SessionSummary {
    return makeSession({
        id,
        active: true,
        metadata: { path: '/p', lifecycleState: 'running' }
    })
}

/** Inactive but never formally archived (imported/completed stub). */
function completedStub(id: string): SessionSummary {
    return makeSession({
        id,
        active: false,
        metadata: { path: '/p' }
    })
}

describe('isSessionArchived', () => {
    it('only treats explicit lifecycleState=archived as archived', () => {
        expect(isSessionArchived(archived('a'))).toBe(true)
        expect(isSessionArchived(running('b'))).toBe(false)
        expect(isSessionArchived(completedStub('c'))).toBe(false)
        expect(isSessionArchived(makeSession({
            id: 'split-brain',
            active: true,
            metadata: { path: '/p', lifecycleState: 'archived' }
        }))).toBe(false)
        expect(isSessionArchived(makeSession({ id: 'd', active: false }))).toBe(false)
    })
})

describe('isSessionArchivable', () => {
    it('accepts live sessions and split-brain rows still marked running', () => {
        const splitBrain = makeSession({
            id: 'sb',
            active: false,
            metadata: { path: '/p', lifecycleState: 'running' }
        })
        expect(isSessionArchivable(running('a'))).toBe(true)
        expect(isSessionArchivable(splitBrain)).toBe(true)
        expect(isSessionArchivable(archived('c'))).toBe(false)
        expect(isSessionArchivable(completedStub('d'))).toBe(false)
    })
})

describe('getProjectGroupActionAvailability', () => {
    it('allows archive-all when any session is archivable', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([
            archived('a'),
            running('b')
        ])
        expect(canArchiveAll).toBe(true)
        // Not all archived → delete blocked.
        expect(canDelete).toBe(false)
    })

    it('blocks delete for inactive sessions that were not archived', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([
            archived('a'),
            completedStub('b')
        ])
        expect(canArchiveAll).toBe(false)
        expect(canDelete).toBe(false)
    })

    it('allows delete only when every session is archived', () => {
        const { canArchiveAll, canDelete } = getProjectGroupActionAvailability([
            archived('a'),
            archived('b')
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

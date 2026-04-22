import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { deduplicateSessionsByAgentId } from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        permissionMode: null,
        collaborationMode: null,
        ...overrides
    }
}

describe('deduplicateSessionsByAgentId', () => {
    it('deduplicates sessions with the same agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // more recent wins
    })

    it('keeps active session over inactive duplicate', () => {
        const sessions = [
            makeSession({ id: 'a', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // active wins despite older updatedAt
    })

    it('prefers selected session among inactive duplicates', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a') // selected wins despite older updatedAt
    })

    it('active always wins over selected inactive', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'b', active: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'a')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('b') // active wins over selected
    })

    it('passes through sessions without agentSessionId', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p' } }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' } }),
            makeSession({ id: 'c', metadata: null })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(3)
    })

    it('deduplicates independently across different agentSessionIds', () => {
        const sessions = [
            makeSession({ id: 'a', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'b', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 }),
            makeSession({ id: 'c', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 100 }),
            makeSession({ id: 'd', metadata: { path: '/p', agentSessionId: 'thread-2' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(2)
        expect(result.map(s => s.id).sort()).toEqual(['b', 'd'])
    })
})

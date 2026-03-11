import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { isSessionUnread, markSessionReadInState } from './sessionReadState'

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: overrides.id ?? 'session-1',
        updatedAt: overrides.updatedAt ?? 100,
        activeAt: overrides.activeAt ?? 100,
        active: overrides.active ?? false,
        pendingRequestsCount: overrides.pendingRequestsCount ?? 0,
        thinking: overrides.thinking ?? false,
        modelMode: overrides.modelMode ?? undefined,
        todoProgress: overrides.todoProgress ?? null,
        metadata: {
            path: '/root/project-a',
            ...overrides.metadata,
        },
    }
}

describe('sessionReadState', () => {
    it('marks a session as unread when it has newer updates than the stored read timestamp', () => {
        const session = createSession({ updatedAt: 200 })

        expect(isSessionUnread(session, { [session.id]: 150 })).toBe(true)
    })

    it('clears unread once the stored read timestamp catches up', () => {
        const session = createSession({ updatedAt: 200 })
        const next = markSessionReadInState({}, session.id, session.updatedAt)

        expect(isSessionUnread(session, next)).toBe(false)
    })

    it('does not move the read timestamp backwards', () => {
        const next = markSessionReadInState({ 'session-1': 300 }, 'session-1', 200)

        expect(next['session-1']).toBe(300)
    })
})

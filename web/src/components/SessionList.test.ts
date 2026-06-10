import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    deduplicateSessionsByAgentId,
    expandSelectedSessionCollapseOverrides,
    getSessionDedupKey,
    getVisibleSessionPreview,
    isSidebarEmptySessionStub,
    normalizeSearch,
    prepareSidebarSessions,
    sessionMatchesQuery,
    shouldShowSessionInSidebar
} from './SessionList'

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
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        model: null,
        effort: null,
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

    it('deduplicates cursor sessions by summary agentSessionId', () => {
        const sessions = [
            makeSession({
                id: 'a',
                active: true,
                metadata: { path: '/p', flavor: 'cursor', agentSessionId: 'acp-thread-1' },
                updatedAt: 100
            }),
            makeSession({
                id: 'b',
                metadata: { path: '/p', flavor: 'cursor', agentSessionId: 'acp-thread-1' },
                updatedAt: 200
            })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('a')
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

    it('does not dedupe across flavors sharing the same flattened agentSessionId', () => {
        const sessions = [
            makeSession({
                id: 'codex',
                metadata: { path: '/p', flavor: 'codex', agentSessionId: 'stale-shared-id' },
                updatedAt: 100
            }),
            makeSession({
                id: 'cursor',
                metadata: { path: '/p', flavor: 'cursor', agentSessionId: 'stale-shared-id' },
                updatedAt: 200
            })
        ]

        expect(getSessionDedupKey(sessions[0])).toBe('codex:stale-shared-id')
        expect(getSessionDedupKey(sessions[1])).toBe('cursor:stale-shared-id')
        expect(deduplicateSessionsByAgentId(sessions).map(session => session.id).sort()).toEqual(['codex', 'cursor'])
        expect(prepareSidebarSessions(sessions).map(session => session.id).sort()).toEqual(['codex', 'cursor'])
    })
})


describe('isSidebarEmptySessionStub', () => {
    it('treats inactive sessions without agent id or title as stubs', () => {
        expect(isSidebarEmptySessionStub(makeSession({
            id: 'stub',
            metadata: { path: '/work/hapi' }
        }))).toBe(true)
    })

    it('does not treat active sessions as stubs', () => {
        expect(isSidebarEmptySessionStub(makeSession({
            id: 'live',
            active: true,
            metadata: { path: '/work/hapi' }
        }))).toBe(false)
    })

    it('does not treat sessions with agentSessionId as stubs', () => {
        expect(isSidebarEmptySessionStub(makeSession({
            id: 'resume',
            metadata: { path: '/work/hapi', agentSessionId: 'thread-1' }
        }))).toBe(false)
    })

    it('does not treat sessions with summary text as stubs', () => {
        expect(isSidebarEmptySessionStub(makeSession({
            id: 'titled',
            metadata: { path: '/work/hapi', summary: { text: 'Fix sidebar' } }
        }))).toBe(false)
    })
})

describe('prepareSidebarSessions', () => {
    it('hides inactive empty stubs but keeps real sessions', () => {
        const sessions = [
            makeSession({ id: 'stub', metadata: { path: '/work/hapi' } }),
            makeSession({
                id: 'real',
                metadata: { path: '/work/hapi', agentSessionId: 'thread-1', summary: { text: 'Real chat' } }
            })
        ]

        const result = prepareSidebarSessions(sessions)
        expect(result.map(session => session.id)).toEqual(['real'])
    })

    it('keeps the selected inactive stub visible', () => {
        const sessions = [
            makeSession({ id: 'stub', metadata: { path: '/work/hapi' } }),
            makeSession({
                id: 'real',
                metadata: { path: '/work/hapi', agentSessionId: 'thread-1' }
            })
        ]

        const result = prepareSidebarSessions(sessions, 'stub')
        expect(result.map(session => session.id).sort()).toEqual(['real', 'stub'])
    })

    it('deduplicates before filtering stubs', () => {
        const sessions = [
            makeSession({ id: 'stub', metadata: { path: '/work/hapi' } }),
            makeSession({
                id: 'older',
                metadata: { path: '/work/hapi', agentSessionId: 'thread-1' },
                updatedAt: 100
            }),
            makeSession({
                id: 'newer',
                metadata: { path: '/work/hapi', agentSessionId: 'thread-1' },
                updatedAt: 200
            })
        ]

        const result = prepareSidebarSessions(sessions)
        expect(result.map(session => session.id)).toEqual(['newer'])
    })
})

describe('shouldShowSessionInSidebar', () => {
    it('always shows active and selected sessions', () => {
        const stub = makeSession({ id: 'stub', metadata: { path: '/work/hapi' } })
        expect(shouldShowSessionInSidebar(stub)).toBe(false)
        expect(shouldShowSessionInSidebar(stub, 'stub')).toBe(true)
        expect(shouldShowSessionInSidebar({ ...stub, active: true })).toBe(true)
    })
})

describe('session list search helpers', () => {
    it('normalizes whitespace and case before filtering', () => {
        const session = makeSession({
            id: 'session-1',
            metadata: {
                path: '/work/hapi',
                name: 'Fix Bot Review',
                flavor: 'codex',
                machineId: 'machine-1'
            }
        })

        expect(normalizeSearch('  BOT  ')).toBe('bot')
        expect(sessionMatchesQuery(session, normalizeSearch('bot review'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('desktop'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('missing'), 'desktop')).toBe(false)
    })
})

describe('getVisibleSessionPreview', () => {
    it('keeps selected and pending sessions inside the collapsed preview without promoting them', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            pendingRequestsCount: index === 4 ? 1 : 0,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, {
            selectedSessionId: 's-6',
            limit: 3
        })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-5', 's-6'])
    })

    it('does not exceed the limit just because many sessions are active', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            active: true,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, { limit: 4 })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-3', 's-4'])
    })

    it('does not move an already-visible selected session to the top', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, {
            selectedSessionId: 's-3',
            limit: 4
        })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-3', 's-4'])
    })

    it('returns all sessions when expanded', () => {
        const sessions = Array.from({ length: 4 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            metadata: { path: '/work/hapi' }
        }))

        expect(getVisibleSessionPreview(sessions, { expanded: true, limit: 2 })).toHaveLength(4)
    })
})


describe('expandSelectedSessionCollapseOverrides', () => {
    it('expands collapsed project and machine, but preserves session preview folding', () => {
        const overrides = new Map<string, boolean>([
            ['machine-1::/work/hapi', true],
            ['sessions::machine-1::/work/hapi', true],
            ['machine::machine-1', true]
        ])

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi',
            machineId: 'machine-1'
        })

        expect(result.has('machine-1::/work/hapi')).toBe(false)
        expect(result.get('sessions::machine-1::/work/hapi')).toBe(true)
        expect(result.has('machine::machine-1')).toBe(false)
    })

    it('leaves missing session preview override unset', () => {
        const overrides = new Map<string, boolean>()

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi',
            machineId: 'machine-1'
        })

        expect(result.has('sessions::machine-1::/work/hapi')).toBe(false)
    })
})

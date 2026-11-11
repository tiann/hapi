import { describe, expect, it } from 'vitest'
import { toSessionSummary, type Session } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import {
    deduplicateSessionsByAgentId,
    expandSelectedSessionCollapseOverrides,
    groupSessionsByDirectory,
    filterActiveSessionsOnly,
    filterUnreadSessionsOnly,
    UNKNOWN_MACHINE_ID,
    bucketRunningSessions,
    filterSessionsForListStatus,
    getNextSessionVisibleCount,
    getPullRefreshIndicatorRotation,
    getPreviousSessionVisibleCount,
    getPullToRefreshState,
    getSessionDedupKey,
    getWorktreeSessionLabel,
    getVisibleSessionPreview,
    isSidebarEmptySessionStub,
    normalizeSearch,
    prepareSidebarSessions,
    sessionMatchesQuery,
    shouldShowPinnedDivider,
    shouldShowSessionInSidebar
} from './SessionList'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('getWorktreeSessionLabel', () => {
    it('returns the worktree name for sessions grouped under a shared repository', () => {
        const session = makeSession({
            id: 'worktree-session',
            metadata: {
                path: '/work/hapi-worktrees/fix-resume',
                worktree: {
                    basePath: '/work/hapi',
                    branch: 'fix/resume',
                    name: 'fix-resume',
                    worktreePath: '/work/hapi-worktrees/fix-resume'
                }
            }
        })

        expect(getWorktreeSessionLabel(session)).toBe('fix-resume')
    })

    it('does not add a subtitle to ordinary sessions', () => {
        const session = makeSession({
            id: 'ordinary-session',
            metadata: { path: '/work/hapi' }
        })

        expect(getWorktreeSessionLabel(session)).toBeNull()
    })

    it('falls back to the worktree directory name when metadata name is blank', () => {
        const session = makeSession({
            id: 'windows-worktree-session',
            metadata: {
                path: 'C:\\work\\hapi-worktrees\\fix-resume',
                worktree: {
                    basePath: 'C:\\work\\hapi',
                    branch: 'fix/resume',
                    name: '   ',
                    worktreePath: 'C:\\work\\hapi-worktrees\\fix-resume\\'
                }
            }
        })

        expect(getWorktreeSessionLabel(session)).toBe('fix-resume')
    })
})

describe('shouldShowPinnedDivider', () => {
    it('shows one divider at the visible pinned-to-unpinned boundary', () => {
        const sessions = [
            makeSession({ id: 'pinned-a', pinned: true }),
            makeSession({ id: 'pinned-b', pinned: true }),
            makeSession({ id: 'regular-a' }),
            makeSession({ id: 'regular-b' })
        ]

        expect(sessions.map((_, index) => shouldShowPinnedDivider(sessions, index)))
            .toEqual([false, false, true, false])
    })

    it('does not show a divider when all visible sessions have the same pin state', () => {
        expect(shouldShowPinnedDivider([
            makeSession({ id: 'a' }),
            makeSession({ id: 'b' })
        ], 1)).toBe(false)
    })
})

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

    it('keeps a job-bearing duplicate when the winner has no attached job', () => {
        const sessions = [
            makeSession({
                id: 'winner-active',
                active: true,
                metadata: { path: '/p', agentSessionId: 'thread-1', flavor: 'codex' },
                updatedAt: 300,
            }),
            makeSession({
                id: 'job-loser',
                active: false,
                metadata: { path: '/p', agentSessionId: 'thread-1', flavor: 'codex' },
                updatedAt: 100,
                attachedJob: {
                    key: 'beets',
                    label: 'beets',
                    status: 'running',
                    heartbeatAt: 1,
                    startedAt: 1,
                    updatedAt: 1,
                },
            }),
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result.map((s) => s.id).sort()).toEqual(['job-loser', 'winner-active'])
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

    it('preserves a pinned session when deduplicating by recency', () => {
        const sessions = [
            makeSession({ id: 'pinned', pinned: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'recent', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions)
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('pinned')
    })

    it('keeps the selected inactive session ahead of a pinned duplicate', () => {
        const sessions = [
            makeSession({ id: 'selected', metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 100 }),
            makeSession({ id: 'pinned', pinned: true, metadata: { path: '/p', agentSessionId: 'thread-1' }, updatedAt: 200 })
        ]
        const result = deduplicateSessionsByAgentId(sessions, 'selected')
        expect(result).toHaveLength(1)
        expect(result[0].id).toBe('selected')
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

    it('keeps an archived Pi session with a native session id and no title', () => {
        const piSession: Session = {
            id: 'archived-pi',
            namespace: 'default',
            seq: 1,
            createdAt: 50,
            active: false,
            activeAt: 0,
            updatedAt: 100,
            metadata: {
                path: '/work/hapi',
                host: 'local',
                flavor: 'pi',
                piSessionId: 'pi-session-1',
                lifecycleState: 'archived'
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            modelReasoningEffort: null,
            effort: null,
            serviceTier: null
        }

        const summary = toSessionSummary(piSession)

        expect(summary.metadata?.agentSessionId).toBe('pi-session-1')
        expect(prepareSidebarSessions([summary]).map(session => session.id)).toEqual(['archived-pi'])
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

    it('keeps a pinned inactive stub visible', () => {
        const sessions = [
            makeSession({ id: 'pinned-stub', pinned: true, metadata: { path: '/work/hapi' } }),
            makeSession({ id: 'stub', metadata: { path: '/work/hapi' } })
        ]

        const result = prepareSidebarSessions(sessions)
        expect(result.map(session => session.id)).toEqual(['pinned-stub'])
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
    it('always shows active, selected, and pinned sessions', () => {
        const stub = makeSession({ id: 'stub', metadata: { path: '/work/hapi' } })
        expect(shouldShowSessionInSidebar(stub)).toBe(false)
        expect(shouldShowSessionInSidebar(stub, 'stub')).toBe(true)
        expect(shouldShowSessionInSidebar({ ...stub, active: true })).toBe(true)
        expect(shouldShowSessionInSidebar({ ...stub, pinned: true })).toBe(true)
    })

    it('keeps idle empty stubs with a running attached job (pre-title register)', () => {
        const stub = makeSession({
            id: 'job-stub',
            active: false,
            metadata: { path: '/work/hapi' },
            attachedJob: {
                key: 'beets',
                label: 'beets import',
                status: 'running',
                heartbeatAt: 1_000,
                startedAt: 1_000,
                updatedAt: 1_000,
                remaining: 10,
            },
        })
        expect(isSidebarEmptySessionStub(stub)).toBe(true)
        expect(shouldShowSessionInSidebar(stub)).toBe(true)
        expect(prepareSidebarSessions([stub]).map((s) => s.id)).toEqual(['job-stub'])
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

    it('matches the displayed worktree label and worktree path', () => {
        const session = makeSession({
            id: 'worktree-session',
            metadata: {
                path: '/work/hapi',
                worktree: {
                    basePath: '/work/hapi',
                    branch: 'fix/sidebar-search',
                    name: 'sidebar-search',
                    worktreePath: '/work/hapi-worktrees/fix-sidebar-search'
                }
            }
        })

        expect(sessionMatchesQuery(session, normalizeSearch('sidebar-search'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('hapi-worktrees'), 'desktop')).toBe(true)
    })

    it('keeps metadata search independent from message content', () => {
        const session = makeSession({
            id: 'metadata-session',
            metadata: { path: '/work/hapi', name: 'Session title' }
        })

        expect(sessionMatchesQuery(session, normalizeSearch('session title'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('message-only phrase'), 'desktop')).toBe(false)
    })

    it('supports complete wildcard patterns without changing plain text matching', () => {
        const session = makeSession({
            id: 'session-123',
            metadata: {
                path: '/work/hapi',
                name: 'Fix Bot Review',
                flavor: 'codex'
            }
        })

        expect(sessionMatchesQuery(session, normalizeSearch('*bot*'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('Fix*Review'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('session-???'), 'desktop')).toBe(true)
        expect(sessionMatchesQuery(session, normalizeSearch('bot*review'), 'desktop')).toBe(false)
        expect(sessionMatchesQuery(session, normalizeSearch('bot review'), 'desktop')).toBe(true)
    })
})

describe('getVisibleSessionPreview', () => {
    it('keeps selected and pending sessions inside the collapsed preview without promoting them', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            active: index === 4,
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

    it('keeps unread sessions inside the preview without promoting them', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, {
            limit: 3,
            isUnread: session => session.id === 's-5'
        })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-5'])
    })

    it('does not let archived pending sessions displace active ones', () => {
        const sessions = Array.from({ length: 6 }, (_, index) => makeSession({
            id: `s-${index + 1}`,
            active: index < 3,
            pendingRequestsCount: index >= 4 ? 1 : 0,
            metadata: { path: '/work/hapi' },
            updatedAt: 100 - index
        }))

        const preview = getVisibleSessionPreview(sessions, { limit: 3 })

        expect(preview.map(session => session.id)).toEqual(['s-1', 's-2', 's-3'])
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


describe('filterActiveSessionsOnly', () => {
    it('keeps only active sessions when no selection', () => {
        const sessions = [
            makeSession({ id: 'live', active: true, metadata: { path: '/p' } }),
            makeSession({ id: 'dead', metadata: { path: '/p' } })
        ]
        expect(filterActiveSessionsOnly(sessions).map(s => s.id)).toEqual(['live'])
    })

    it('keeps the selected inactive session visible', () => {
        const sessions = [
            makeSession({ id: 'live', active: true, metadata: { path: '/p' } }),
            makeSession({ id: 'dead', metadata: { path: '/p' } }),
            makeSession({ id: 'selected-dead', metadata: { path: '/p' } })
        ]
        expect(filterActiveSessionsOnly(sessions, 'selected-dead').map(s => s.id).sort())
            .toEqual(['live', 'selected-dead'])
    })

    it('preserves input order', () => {
        const sessions = [
            makeSession({ id: 'a', active: true, metadata: { path: '/p' } }),
            makeSession({ id: 'b', metadata: { path: '/p' } }),
            makeSession({ id: 'c', active: true, metadata: { path: '/p' } })
        ]
        expect(filterActiveSessionsOnly(sessions).map(s => s.id)).toEqual(['a', 'c'])
    })
})

describe('filterUnreadSessionsOnly', () => {
    const sessions = [
        makeSession({ id: 'unread', metadata: { path: '/p' } }),
        makeSession({ id: 'read', metadata: { path: '/p' } }),
        makeSession({ id: 'open', metadata: { path: '/p' } })
    ]
    const isUnread = (s: { id: string }) => s.id === 'unread'

    it('keeps only unread sessions when nothing is open', () => {
        expect(filterUnreadSessionsOnly(sessions, isUnread).map(s => s.id)).toEqual(['unread'])
    })

    it('keeps the open session visible even when read', () => {
        expect(filterUnreadSessionsOnly(sessions, isUnread, 'open').map(s => s.id)).toEqual(['unread', 'open'])
    })
})

describe('getNextSessionVisibleCount', () => {
    it('reveals one batch of step size per call', () => {
        expect(getNextSessionVisibleCount(8, 8, 20)).toBe(16)
        expect(getNextSessionVisibleCount(16, 8, 20)).toBe(20)
    })

    it('never exceeds the total session count', () => {
        expect(getNextSessionVisibleCount(18, 8, 20)).toBe(20)
        expect(getNextSessionVisibleCount(20, 8, 20)).toBe(20)
    })

    it('always advances by at least one even with a zero step', () => {
        expect(getNextSessionVisibleCount(5, 0, 20)).toBe(6)
    })
})

describe('getPreviousSessionVisibleCount', () => {
    it('collapses one batch of step size per call', () => {
        expect(getPreviousSessionVisibleCount(20, 8)).toBe(12)
        expect(getPreviousSessionVisibleCount(12, 8)).toBe(8)
    })

    it('never goes below the preview limit', () => {
        expect(getPreviousSessionVisibleCount(10, 8)).toBe(8)
        expect(getPreviousSessionVisibleCount(8, 8)).toBe(8)
    })

    it('uses a minimum batch size of one', () => {
        expect(getPreviousSessionVisibleCount(5, 0)).toBe(4)
    })
})

describe('expandSelectedSessionCollapseOverrides', () => {
    it('expands the collapsed project group, but preserves session preview folding', () => {
        const overrides = new Map<string, boolean>([
            ['machine-1::/work/hapi', true],
            ['sessions::machine-1::/work/hapi', true]
        ])

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi'
        })

        expect(result.get('machine-1::/work/hapi')).toBe(false)
        expect(result.get('sessions::machine-1::/work/hapi')).toBe(true)
    })

    it('leaves missing session preview override unset', () => {
        const overrides = new Map<string, boolean>()

        const result = expandSelectedSessionCollapseOverrides(overrides, {
            key: 'machine-1::/work/hapi'
        })

        expect(result.has('sessions::machine-1::/work/hapi')).toBe(false)
    })
})

describe('getPullToRefreshState', () => {
    it('requires a deliberate pull past the trigger distance', () => {
        expect(getPullToRefreshState(15)).toBe('idle')
        expect(getPullToRefreshState(16)).toBe('pulling')
        expect(getPullToRefreshState(63)).toBe('pulling')
        expect(getPullToRefreshState(64)).toBe('ready')
    })
})

describe('getPullRefreshIndicatorRotation', () => {
    it('turns the pull indicator upward once refresh is ready', () => {
        expect(getPullRefreshIndicatorRotation('pulling')).toBe(0)
        expect(getPullRefreshIndicatorRotation('ready')).toBe(180)
    })
})

describe('bucketRunningSessions', () => {
    // Quiet connected / keepalive-idle never float (#1404). Under mode `all`,
    // only working / pending / running attachedJob reach the In progress section.
    const quiet = makeSession({
        id: 'quiet-1',
        active: true,
        updatedAt: 20,
        metadata: { path: '/p', host: 'h', lifecycleState: 'running' } as SessionSummary['metadata']
    })
    const withJob = makeSession({
        id: 'job-1',
        active: false,
        updatedAt: 30,
        attachedJob: {
            key: 'batch',
            label: 'batch',
            status: 'running',
            heartbeatAt: 1,
            startedAt: 1,
            updatedAt: 1,
        },
        attachedJobUpdatedAt: 1,
    })

    it('leaves quiet connected out of every pin bucket', () => {
        const buckets = bucketRunningSessions([quiet], 'all')
        expect(buckets.jobs).toHaveLength(0)
        expect(buckets.working).toHaveLength(0)
        expect(buckets.pending).toHaveLength(0)
    })

    it('puts running attachedJob into jobs under mode jobs', () => {
        const buckets = bucketRunningSessions([withJob, quiet], 'jobs')
        expect(buckets.jobs.map((s) => s.id)).toEqual(['job-1'])
        expect(buckets.working).toHaveLength(0)
        expect(buckets.pending).toHaveLength(0)
    })

    it('buckets working and pending under mode all', () => {
        expect(bucketRunningSessions([{ ...quiet, backgroundTaskCount: 1 }], 'all').working).toHaveLength(1)
        expect(bucketRunningSessions([{ ...quiet, pendingRequestsCount: 1 }], 'all').pending).toHaveLength(1)
    })

    it('lets pending outrank jobs when both apply', () => {
        const both = {
            ...withJob,
            active: true,
            pendingRequestsCount: 1,
        }
        const buckets = bucketRunningSessions([both], 'all')
        expect(buckets.pending.map((s) => s.id)).toEqual(['job-1'])
        expect(buckets.jobs).toHaveLength(0)
    })

    it('ignores disconnected (no job) and pinned sessions', () => {
        const buckets = bucketRunningSessions([
            { ...quiet, active: false },
            { ...withJob, id: 'job-pinned', pinned: true },
        ], 'all')
        expect(buckets.jobs).toHaveLength(0)
        expect(buckets.working).toHaveLength(0)
        expect(buckets.pending).toHaveLength(0)
    })
})

describe('session list user-activity ordering', () => {
    const session = (id: string, at: number, path = '/proj', extra: Partial<SessionSummary> = {}) =>
        makeSession({ id, createdAt: at, lastUserMessageAt: at, metadata: { path }, ...extra })
    const ids = (sessions: SessionSummary[]) => groupSessionsByDirectory(sessions).flatMap(g => g.sessions.map(s => s.id))

    it('keeps rows and projects stable through output, completion and permission changes', () => {
        const sessions = [session('a', 1_000, '/a'), session('b', 2_000, '/b'), session('c', 3_000, '/b')]
        expect(ids(sessions)).toEqual(['c', 'b', 'a'])
        const noisy = sessions.map(s => ({ ...s, updatedAt: 99_000, active: s.id === 'a', pendingRequestsCount: 4, thinking: true }))
        expect(ids(noisy.reverse())).toEqual(['c', 'b', 'a'])
        expect(ids(sessions.map(s => s.id === 'a' ? { ...s, lastUserMessageAt: 100_000 } : s))).toEqual(['a', 'c', 'b'])
    })

    it('keeps manual pins ahead of user recency', () => {
        expect(ids([session('new', 9_000), session('pinned', 1_000, '/proj', { pinned: true })])).toEqual(['pinned', 'new'])
        expect(ids([session('new', 9_000, '/new'), session('pinned', 1_000, '/old', { pinned: true })])).toEqual(['pinned', 'new'])
    })

    it('uses creation time before any user input and deterministic ties on refetch', () => {
        const sessions = [session('b', 2_000, '/b', { lastUserMessageAt: undefined }), session('a', 2_000, '/a', { lastUserMessageAt: undefined })]
        expect(ids(sessions)).toEqual(['a', 'b'])
        expect(ids([...sessions].reverse())).toEqual(['a', 'b'])
    })

    it('keeps the optional in-progress layout, with stable order inside each bucket', () => {
        const sessions = [session('old', 1_000, '/proj', { active: true, thinking: true, updatedAt: 90_000 }), session('new', 2_000, '/proj', { active: true, thinking: true, updatedAt: 1 })]
        expect(bucketRunningSessions(sessions, 'all').working.map(s => s.id)).toEqual(['new', 'old'])
        expect(bucketRunningSessions(sessions.map(s => ({ ...s, updatedAt: 200_000 })), 'all').working.map(s => s.id)).toEqual(['new', 'old'])
    })

    it('fixed created-at order keeps rows and workspaces when lastUserMessageAt moves', () => {
        const createdView = { sort: 'created' as const, activeFirst: false }
        const fixedIds = (sessions: SessionSummary[]) =>
            groupSessionsByDirectory(sessions, createdView).flatMap(g => g.sessions.map(s => s.id))
        const sessions = [session('old', 1_000, '/old'), session('new', 2_000, '/new')]
        expect(fixedIds(sessions)).toEqual(['new', 'old'])
        const bumped = sessions.map(s => s.id === 'old'
            ? { ...s, lastUserMessageAt: 100_000 }
            : s)
        expect(fixedIds(bumped)).toEqual(['new', 'old'])
        expect(groupSessionsByDirectory(bumped, createdView).map(g => g.directory)).toEqual(['/new', '/old'])
    })
})

describe('session list sort and filter view', () => {
    const session = (id: string, extra: Partial<SessionSummary> & { path?: string } = {}) => {
        const { path = '/proj', ...rest } = extra
        return makeSession({ id, createdAt: 1_000, lastUserMessageAt: 1_000, updatedAt: 1_000, metadata: { path }, ...rest })
    }
    const ids = (sessions: SessionSummary[], view: Parameters<typeof groupSessionsByDirectory>[1]) =>
        groupSessionsByDirectory(sessions, view).flatMap(g => g.sessions.map(s => s.id))

    it('orders by last message or creation time, never by agent output', () => {
        const sessions = [
            session('old-chatty', { createdAt: 1_000, lastUserMessageAt: 9_000, updatedAt: 9_000 }),
            session('new-quiet', { createdAt: 5_000, lastUserMessageAt: 5_000, updatedAt: 5_000 }),
            session('agent-busy', { createdAt: 2_000, lastUserMessageAt: 3_000, updatedAt: 20_000 })
        ]
        expect(ids(sessions, { sort: 'last-message', activeFirst: false })).toEqual(['old-chatty', 'new-quiet', 'agent-busy'])
        expect(ids(sessions, { sort: 'created', activeFirst: false })).toEqual(['new-quiet', 'agent-busy', 'old-chatty'])
    })

    it('puts active sessions and projects ahead of archived ones when active-first is on', () => {
        const sessions = [
            session('archived-recent', { lastUserMessageAt: 9_000, path: '/a' }),
            session('active-older', { lastUserMessageAt: 2_000, path: '/a', active: true }),
            session('archived-project', { lastUserMessageAt: 8_000, path: '/b' }),
            session('active-project', { lastUserMessageAt: 1_000, path: '/c', active: true })
        ]
        expect(ids(sessions, { sort: 'last-message', activeFirst: true }))
            .toEqual(['active-older', 'archived-recent', 'active-project', 'archived-project'])
        expect(ids(sessions, { sort: 'last-message', activeFirst: false }))
            .toEqual(['archived-recent', 'active-older', 'archived-project', 'active-project'])
    })

    it('still keeps manual pins first when active-first is on', () => {
        const sessions = [
            session('active', { active: true }),
            session('pinned-archived', { pinned: true })
        ]
        expect(ids(sessions, { sort: 'last-message', activeFirst: true })).toEqual(['pinned-archived', 'active'])
    })
})

describe('filterSessionsForListStatus', () => {
    const base = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
        makeSession({ id, active: false, metadata: { path: '/p' }, ...extra })

    it('keeps inactive running-job rows under the active status filter', () => {
        const job = base('job', {
            attachedJob: {
                key: 'drain', label: 'drain', status: 'running',
                heartbeatAt: 1, startedAt: 1, updatedAt: 1
            }
        })
        const idle = base('idle')
        const ids = filterSessionsForListStatus([job, idle], 'active', null).map(s => s.id)
        expect(ids).toEqual(['job'])
    })

    it('excludes running-job rows from the archived status filter', () => {
        const job = base('job', {
            attachedJob: {
                key: 'drain', label: 'drain', status: 'running',
                heartbeatAt: 1, startedAt: 1, updatedAt: 1
            }
        })
        const archived = base('archived')
        const ids = filterSessionsForListStatus([job, archived], 'archived', null).map(s => s.id)
        expect(ids).toEqual(['archived'])
    })
})

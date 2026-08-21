import { describe, expect, it } from 'vitest'
import { toSessionSummary, type Session } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import {
    deduplicateSessionsByAgentId,
    expandSelectedSessionCollapseOverrides,
    filterActiveSessionsOnly,
    filterUnreadSessionsOnly,
    UNKNOWN_MACHINE_ID,
    getSessionTimeRange,
    getNextSessionVisibleCount,
    getPullRefreshIndicatorRotation,
    getPreviousSessionVisibleCount,
    getPullToRefreshState,
    getSessionDedupKey,
    getWorktreeSessionLabel,
    getVisibleSessionPreview,
    groupSessionsByDirectory,
    isSidebarEmptySessionStub,
    normalizeSearch,
    prepareSidebarSessions,
    resolveSessionGroupDirectory,
    sessionMatchesQuery,
    sessionMatchesTimeRange,
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

describe('session list time filter helpers', () => {
    it('treats the selected end date as inclusive in local time', () => {
        const range = getSessionTimeRange('2026-07-01', '2026-07-18')
        expect(range).toEqual({
            start: new Date(2026, 6, 1).getTime(),
            end: new Date(2026, 6, 19).getTime()
        })
        expect(sessionMatchesTimeRange(makeSession({ id: 'inside', updatedAt: new Date(2026, 6, 18, 23, 59).getTime() }), range)).toBe(true)
        expect(sessionMatchesTimeRange(makeSession({ id: 'outside', updatedAt: new Date(2026, 6, 19).getTime() }), range)).toBe(false)
    })

    it('does not filter until both dates are selected', () => {
        expect(getSessionTimeRange('', '')).toBeNull()
        expect(getSessionTimeRange('2026-07-01', '')).toBeNull()
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
    const lastSeen = (id: string): number => {
        if (id === 'unread') return 1000
        return 10_000
    }

    it('keeps only sessions newer than lastSeen; drops seen and selected-only quiet rows stay when selected', () => {
        const sessions = [
            makeSession({ id: 'unread', updatedAt: 5000, metadata: { path: '/p' } }),
            makeSession({ id: 'seen', updatedAt: 1000, metadata: { path: '/p' } }),
            makeSession({
                id: 'permission-but-seen',
                pendingRequestKinds: ['permission'],
                pendingRequestsCount: 1,
                updatedAt: 1000,
                metadata: { path: '/p' },
            }),
        ]
        expect(filterUnreadSessionsOnly(sessions, null, lastSeen).map(s => s.id))
            .toEqual(['unread'])
    })

    it('keeps the selected session visible even when it would otherwise filter out', () => {
        const sessions = [
            makeSession({ id: 'unread', updatedAt: 5000, metadata: { path: '/p' } }),
            makeSession({ id: 'selected-quiet', updatedAt: 1000, metadata: { path: '/p' } }),
        ]
        expect(filterUnreadSessionsOnly(sessions, 'selected-quiet', lastSeen).map(s => s.id))
            .toEqual(['unread', 'selected-quiet'])
    })

    it('composes with machine filter as empty intersection (unread after machine scope stays selected)', () => {
        // Mirrors SessionList pipeline: unread on visibleSessions, then machine filter.
        // Machine B selected + only machine A unread → empty list, not "all unread".
        const sessions = [
            makeSession({
                id: 'unread-a',
                updatedAt: 5000,
                metadata: { path: '/a', machineId: 'machine-a' },
            }),
            makeSession({
                id: 'seen-b',
                updatedAt: 1000,
                metadata: { path: '/b', machineId: 'machine-b' },
            }),
        ]
        const lastSeenById = (id: string) => (id === 'unread-a' ? 0 : 10_000)
        const unreadFiltered = filterUnreadSessionsOnly(sessions, null, lastSeenById)
        const machineB = unreadFiltered.filter(
            session => (session.metadata?.machineId ?? UNKNOWN_MACHINE_ID) === 'machine-b'
        )
        expect(unreadFiltered.map(s => s.id)).toEqual(['unread-a'])
        expect(machineB).toEqual([])
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


describe('resolveSessionGroupDirectory', () => {
    it('uses worktree.basePath when the session path lives under it', () => {
        expect(resolveSessionGroupDirectory({
            path: '/home/heavygee/coding/hapi/worktrees/feat-x',
            worktree: { basePath: '/home/heavygee/coding/hapi' },
        })).toBe('/home/heavygee/coding/hapi')
    })

    it('falls back to metadata.path when basePath is missing', () => {
        expect(resolveSessionGroupDirectory({
            path: '/home/heavygee/coding/server-setup',
        })).toBe('/home/heavygee/coding/server-setup')
    })

    it('rewrites logical path spelling when realpathed worktreePath sits under basePath', () => {
        // Estate: CLI realpaths worktreePath/basePath; metadata.path may keep ~/coding.
        expect(resolveSessionGroupDirectory({
            path: '/home/heavygee/coding/hapi/worktrees/cursor-mcp-isolation',
            worktree: {
                basePath: '/work/coding/hapi',
                worktreePath: '/work/coding/hapi/worktrees/cursor-mcp-isolation',
            },
        })).toBe('/home/heavygee/coding/hapi')
    })

    it('keeps an external same-suffix worktree under basePath', () => {
        // worktreePath is NOT under basePath — no alias evidence.
        expect(resolveSessionGroupDirectory({
            path: '/home/me/org/repo/worktrees/feature',
            worktree: {
                basePath: '/mnt/clone/org/repo',
                worktreePath: '/home/me/org/repo/worktrees/feature',
            },
        })).toBe('/mnt/clone/org/repo')
    })

    it('keeps a pure realpath session under the realpath root', () => {
        expect(resolveSessionGroupDirectory({
            path: '/work/coding/hapi',
            worktree: { basePath: '/work/coding/hapi' },
        })).toBe('/work/coding/hapi')
    })

    it('preserves POSIX and Windows filesystem roots', () => {
        expect(resolveSessionGroupDirectory({ path: '/' })).toBe('/')
        expect(resolveSessionGroupDirectory({ path: 'C:\\' })).toBe('C:\\')
        expect(resolveSessionGroupDirectory({
            path: 'C:\\',
            worktree: { basePath: 'C:\\' },
        })).toBe('C:\\')
    })

    it('preserves trailing whitespace in filesystem paths', () => {
        expect(resolveSessionGroupDirectory({
            path: '/srv/project ',
        })).toBe('/srv/project ')
        expect(resolveSessionGroupDirectory({
            path: '/srv/project /worktrees/feature',
            worktree: { basePath: '/srv/project ' },
        })).toBe('/srv/project ')
    })

    it('preserves trailing backslash on POSIX paths', () => {
        expect(resolveSessionGroupDirectory({
            path: '/srv/project\\',
        })).toBe('/srv/project\\')
    })

    it('returns Other when neither path nor basePath is set', () => {
        expect(resolveSessionGroupDirectory({})).toBe('Other')
    })
})

describe('groupSessionsByDirectory symlink coalesce', () => {
    it('places symlink-prefix and realpath basePath sessions in one project group', () => {
        const homeSpelling = makeSession({
            id: 'home',
            updatedAt: 2,
            metadata: {
                machineId: 'machine-oos',
                path: '/home/heavygee/coding/hapi',
                worktree: {
                    basePath: '/home/heavygee/coding/hapi',
                    branch: 'main',
                    name: 'driver',
                    worktreePath: '/home/heavygee/coding/hapi/driver',
                },
            },
        })
        const realpathBase = makeSession({
            id: 'work',
            updatedAt: 1,
            active: true,
            metadata: {
                machineId: 'machine-oos',
                path: '/home/heavygee/coding/hapi/worktrees/feat-x',
                worktree: {
                    basePath: '/work/coding/hapi',
                    branch: 'feat/x',
                    name: 'feat-x',
                    worktreePath: '/work/coding/hapi/worktrees/feat-x',
                },
            },
        })

        const groups = groupSessionsByDirectory([homeSpelling, realpathBase])
        expect(groups).toHaveLength(1)
        expect(groups[0]?.directory).toBe('/home/heavygee/coding/hapi')
        expect(groups[0]?.displayName).toBe('coding/hapi')
        expect(groups[0]?.sessions.map((s) => s.id).sort()).toEqual(['home', 'work'])
    })

    it('does not invent a home root for an external same-suffix worktree alone', () => {
        const external = makeSession({
            id: 'external-wt',
            updatedAt: 1,
            metadata: {
                machineId: 'machine-oos',
                path: '/home/me/org/repo/worktrees/feature',
                worktree: {
                    basePath: '/mnt/clone/org/repo',
                    branch: 'feature',
                    name: 'feature',
                    worktreePath: '/home/me/org/repo/worktrees/feature',
                },
            },
        })

        const groups = groupSessionsByDirectory([external])
        expect(groups).toHaveLength(1)
        expect(groups[0]?.directory).toBe('/mnt/clone/org/repo')
        expect(groups[0]?.displayName).toBe('org/repo')
    })

    it('keeps an external worktree separate from an unrelated same-suffix clone', () => {
        const unrelatedClone = makeSession({
            id: 'clone',
            updatedAt: 2,
            metadata: {
                machineId: 'machine-oos',
                path: '/home/me/org/repo',
                worktree: {
                    basePath: '/home/me/org/repo',
                    branch: 'main',
                    name: 'main',
                    worktreePath: '/home/me/org/repo',
                },
            },
        })
        const external = makeSession({
            id: 'external-wt',
            updatedAt: 1,
            metadata: {
                machineId: 'machine-oos',
                path: '/home/me/org/repo/worktrees/feature',
                worktree: {
                    basePath: '/mnt/clone/org/repo',
                    branch: 'feature',
                    name: 'feature',
                    worktreePath: '/home/me/org/repo/worktrees/feature',
                },
            },
        })

        const groups = groupSessionsByDirectory([unrelatedClone, external])
        expect(groups).toHaveLength(2)
        expect(groups.map((g) => g.directory).sort()).toEqual([
            '/home/me/org/repo',
            '/mnt/clone/org/repo',
        ])
    })
})

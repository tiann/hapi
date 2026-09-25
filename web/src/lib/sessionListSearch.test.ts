import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    SESSION_SEARCH_FIELD_WEIGHTS,
    buildSessionSearchScoreIndex,
    compareSessionsBySearchRelevance,
    rankSessionGroupsBySearchRelevance,
    searchFieldHasBoundaryMatch,
    searchFieldIncludesQuery,
    sessionMatchesQuery,
    sortSessionsBySearchRelevance,
} from './sessionListSearch'
import { shouldShowPinnedDivider } from '@/components/SessionList'

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
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        ...overrides,
    }
}

describe('search field match helpers', () => {
    it('includes mid-token substrings so as-you-type still works', () => {
        expect(searchFieldIncludesQuery('homelab', 'home')).toBe(true)
        expect(searchFieldIncludesQuery('session-search-rank', 'sess')).toBe(true)
    })

    it('detects boundary affinity separately from inclusion', () => {
        expect(searchFieldHasBoundaryMatch('homelab', 'home')).toBe(false)
        expect(searchFieldHasBoundaryMatch('home-lab', 'home')).toBe(true)
        expect(searchFieldHasBoundaryMatch('Home Assistant', 'home')).toBe(true)
        expect(searchFieldHasBoundaryMatch('/home/heavygee/coding/hapi', 'home')).toBe(true)
    })
})

describe('sessionMatchesQuery', () => {
    it('keeps path searchable including OS home prefixes', () => {
        const underHome = makeSession({
            id: 'meta',
            metadata: { path: '/home/heavygee/coding/hapi', name: 'meta HAPI triage' },
        })
        expect(sessionMatchesQuery(underHome, 'home', 'oos')).toBe(true)
        expect(sessionMatchesQuery(underHome, 'hapi', 'oos')).toBe(true)
        expect(sessionMatchesQuery(underHome, 'hap', 'oos')).toBe(true)
    })

    it('still matches machine label substrings for shared callers', () => {
        const session = makeSession({
            id: 'docs',
            metadata: { path: '/work/docs', name: 'Peer docs' },
        })
        expect(sessionMatchesQuery(session, 'home', 'homelab')).toBe(true)
        expect(sessionMatchesQuery(session, 'lab', 'homelab')).toBe(true)
    })

    it('matches wildcards against individual path parts, not a joined blob', () => {
        const session = makeSession({
            id: 'wt',
            metadata: {
                path: '/home/heavygee/coding/hapi',
                worktree: {
                    basePath: '/home/heavygee/coding/hapi',
                    branch: 'feat/x',
                    name: 'x',
                    worktreePath: '/home/heavygee/coding/hapi-worktrees/x',
                },
            },
        })
        expect(sessionMatchesQuery(session, '*coding/hapi', 'oos')).toBe(true)
    })
})

describe('session search relevance ranking', () => {
    it('gives title hits higher field weight than path hits', () => {
        expect(SESSION_SEARCH_FIELD_WEIGHTS.title).toBeGreaterThan(SESSION_SEARCH_FIELD_WEIGHTS.path)
    })

    it('ranks Home Assistant above recent path-only /home/ and mid-token homelab matches', () => {
        const homeAssistant = makeSession({
            id: 'd755080b',
            updatedAt: 100,
            metadata: {
                path: '/home/heavygee/coding/home-assistant',
                name: 'Home Assistant',
                machineId: 'oos',
            },
        })
        const recentMeta = makeSession({
            id: 'meta-triage',
            updatedAt: 9_000,
            metadata: {
                path: '/home/heavygee/coding/hapi',
                name: 'meta HAPI triage/problems',
                machineId: 'oos',
            },
        })
        const homeLabHost = makeSession({
            id: 'on-homelab',
            updatedAt: 9_500,
            metadata: {
                path: '/work/docs',
                name: 'Peer docs',
                machineId: 'homelab-machine',
            },
        })

        const corpus = [recentMeta, homeLabHost, homeAssistant]
        const index = buildSessionSearchScoreIndex(corpus, 'Home', (machineId) =>
            machineId === 'homelab-machine' ? 'homelab' : 'oos'
        )

        expect(index.matchedIds.has('d755080b')).toBe(true)
        expect(index.matchedIds.has('meta-triage')).toBe(true)
        expect(index.matchedIds.has('on-homelab')).toBe(true)
        expect(index.scores.get('d755080b') ?? 0).toBeGreaterThan(index.scores.get('meta-triage') ?? 0)
        expect(index.scores.get('d755080b') ?? 0).toBeGreaterThan(index.scores.get('on-homelab') ?? 0)

        const ranked = sortSessionsBySearchRelevance(corpus, index)
        expect(ranked[0]?.id).toBe('d755080b')
        expect(compareSessionsBySearchRelevance(ranked[0]!, ranked[1]!, index)).toBeLessThan(0)
    })

    it('requires every query term (AND) so path-only Home does not match Home Assistant', () => {
        const homeAssistant = makeSession({
            id: 'ha',
            updatedAt: 1,
            metadata: { path: '/home/heavygee/coding/x', name: 'Home Assistant' },
        })
        const onlyHomePath = makeSession({
            id: 'path-only',
            updatedAt: 99_000,
            metadata: { path: '/home/heavygee/coding/other', name: 'other work' },
        })

        const index = buildSessionSearchScoreIndex(
            [onlyHomePath, homeAssistant],
            'Home Assistant',
            () => 'oos'
        )
        const ranked = sortSessionsBySearchRelevance([onlyHomePath, homeAssistant], index)
        expect(ranked[0]?.id).toBe('ha')
        expect(index.matchedIds.has('path-only')).toBe(false)
        expect(index.matchedIds.has('ha')).toBe(true)
    })

    it('prefers an exact / contiguous title phrase over term-scrambled titles', () => {
        // tiann #1842: query "Home Assistant" scored identically for both titles,
        // so the newer scrambled title won on recency alone.
        const exact = makeSession({
            id: 'exact-title',
            updatedAt: 100,
            metadata: { path: '/work/a', name: 'Home Assistant' },
        })
        const scrambled = makeSession({
            id: 'scrambled-title',
            updatedAt: 99_000,
            metadata: { path: '/work/b', name: 'Assistant for Home' },
        })
        const index = buildSessionSearchScoreIndex([scrambled, exact], 'Home Assistant', () => 'oos')
        expect(index.matchedIds.has('exact-title')).toBe(true)
        expect(index.matchedIds.has('scrambled-title')).toBe(true)
        expect(index.scores.get('exact-title') ?? 0).toBeGreaterThan(
            index.scores.get('scrambled-title') ?? 0
        )
        expect(sortSessionsBySearchRelevance([scrambled, exact], index)[0]?.id).toBe('exact-title')
    })

    it('picks the best field by post-bonus contribution, not raw weight', () => {
        // Summary mid-token (weight 3) vs machine boundary (2 × 1.75 = 3.5):
        // raw-weight picker keeps summary; post-bonus picks machine.
        const session = makeSession({
            id: 'boundary-wins',
            updatedAt: 1,
            metadata: {
                path: '/work/x',
                name: 'unrelated',
                summary: { text: 'homelab notes' },
                machineId: 'home-box',
            },
        })
        const index = buildSessionSearchScoreIndex([session], 'home', (id) =>
            id === 'home-box' ? 'Home' : 'oos'
        )
        expect(index.matchedIds.has('boundary-wins')).toBe(true)
        const withMachine = index.scores.get('boundary-wins') ?? 0
        expect(withMachine).toBeGreaterThan(0)
        const summaryOnly = buildSessionSearchScoreIndex([session], 'home', () => 'oos')
        expect(summaryOnly.scores.get('boundary-wins') ?? 0).toBeLessThan(withMachine)
    })

    it('keeps project-pinned sessions contiguous under relevance sort (one pin divider)', () => {
        // tiann #1842 repro: interleaved pin→ordinary→pin→ordinary drew two dividers.
        const homePinned = makeSession({
            id: 'home-pinned',
            pinned: true,
            updatedAt: 400,
            metadata: { path: '/work/proj', name: 'Home pinned' },
        })
        const homeOrdinary = makeSession({
            id: 'home-ordinary',
            updatedAt: 300,
            metadata: { path: '/work/proj', name: 'Home ordinary' },
        })
        const homelabPinned = makeSession({
            id: 'homelab-pinned',
            pinned: true,
            updatedAt: 200,
            metadata: { path: '/work/proj', name: 'homelab pinned' },
        })
        const homelabOrdinary = makeSession({
            id: 'homelab-ordinary',
            updatedAt: 100,
            metadata: { path: '/work/proj', name: 'homelab ordinary' },
        })
        const sessions = [homePinned, homeOrdinary, homelabPinned, homelabOrdinary]
        const index = buildSessionSearchScoreIndex(sessions, 'home', () => 'oos')
        const [group] = rankSessionGroupsBySearchRelevance(
            [{
                sessions: [...sessions],
                hasPinnedSession: true,
                hasActiveSession: false,
                latestUpdatedAt: 400,
            }],
            index
        )
        expect(group?.sessions.map((s) => s.id)).toEqual([
            'home-pinned',
            'homelab-pinned',
            'home-ordinary',
            'homelab-ordinary',
        ])
        const dividers = group!.sessions
            .map((_, i) => shouldShowPinnedDivider(group!.sessions, i))
            .filter(Boolean)
        expect(dividers).toHaveLength(1)
    })
})

describe('sessionMatchesQuery multi-word inclusion (shared callers)', () => {
    it('requires every token (AND) across fields for mentions / share picker', () => {
        const session = makeSession({
            id: 'cross-field',
            metadata: {
                path: '/work/home-lab',
                name: 'Assistant notes',
                summary: { text: 'unrelated' },
            },
        })
        // "home" hits path; "assistant" hits title — AND across fields is intentional.
        expect(sessionMatchesQuery(session, 'home assistant', 'oos')).toBe(true)
        expect(sessionMatchesQuery(session, 'home missing', 'oos')).toBe(false)
    })

    it('rejects when only one of two query terms is present', () => {
        const session = makeSession({
            id: 'partial',
            metadata: { path: '/work/x', name: 'Home lab' },
        })
        expect(sessionMatchesQuery(session, 'home', 'oos')).toBe(true)
        expect(sessionMatchesQuery(session, 'home assistant', 'oos')).toBe(false)
    })
})

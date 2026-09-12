import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    SESSION_SEARCH_FIELD_WEIGHTS,
    buildSessionSearchScoreIndex,
    compareSessionsBySearchRelevance,
    idfForDocumentFrequency,
    searchFieldHasBoundaryMatch,
    searchFieldIncludesQuery,
    sessionMatchesQuery,
    sortSessionsBySearchRelevance,
} from './sessionListSearch'

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

    it('down-weights terms that match most of the corpus (IDF)', () => {
        const common = idfForDocumentFrequency(100, 100)
        const rare = idfForDocumentFrequency(100, 1)
        expect(rare).toBeGreaterThan(common)
        expect(common).toBeGreaterThan(0)
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

    it('lets a distinctive second term dominate when the first term is ubiquitous', () => {
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

    it('picks the best field by post-bonus contribution, not raw weight', () => {
        // Machine "Home" (weight 2 × boundary 1.75 = 3.5) must beat a mid-token
        // title hit like "homelab" (weight 10 × 1 = 10)... wait, 10 > 3.5 so title still wins.
        // Use summary (weight 3, mid-token) vs machine boundary (2 × 1.75 = 3.5):
        // raw-weight picker would keep summary (3 > 2) → score 3; post-bonus picks machine → 3.5.
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
        // Sanity: score should reflect machine boundary contribution (2 * idf * 1.75),
        // not the weaker mid-token summary contribution (3 * idf * 1).
        const idfAlone = index.scores.get('boundary-wins') ?? 0
        expect(idfAlone).toBeGreaterThan(0)
        // Rebuild with only summary match to compare: strip machine label.
        const summaryOnly = buildSessionSearchScoreIndex([session], 'home', () => 'oos')
        expect(summaryOnly.scores.get('boundary-wins') ?? 0).toBeLessThan(idfAlone)
    })
})

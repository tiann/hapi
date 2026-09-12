import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    SESSION_SEARCH_FIELD_WEIGHTS,
    buildSessionSearchScoreIndex,
    compareSessionsBySearchRelevance,
    idfForDocumentFrequency,
    searchFieldMatchesQuery,
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

describe('searchFieldMatchesQuery', () => {
    it('matches on alphanumeric boundaries so home does not hit homelab', () => {
        expect(searchFieldMatchesQuery('homelab', 'home')).toBe(false)
        expect(searchFieldMatchesQuery('home-lab', 'home')).toBe(true)
        expect(searchFieldMatchesQuery('Home Assistant', 'home')).toBe(true)
        expect(searchFieldMatchesQuery('/home/heavygee/coding/hapi', 'home')).toBe(true)
    })
})

describe('sessionMatchesQuery', () => {
    it('keeps path and title searchable including OS home prefixes', () => {
        const underHome = makeSession({
            id: 'meta',
            metadata: { path: '/home/heavygee/coding/hapi', name: 'meta HAPI triage' },
        })
        expect(sessionMatchesQuery(underHome, 'home', 'oos')).toBe(true)
        expect(sessionMatchesQuery(underHome, 'hapi', 'oos')).toBe(true)
        expect(sessionMatchesQuery(underHome, 'homelab', 'oos')).toBe(false)
        expect(sessionMatchesQuery(underHome, 'home', 'homelab')).toBe(true)
    })

    it('does not match machine label homelab for query home', () => {
        const session = makeSession({
            id: 'docs',
            metadata: { path: '/work/docs', name: 'Peer docs' },
        })
        expect(sessionMatchesQuery(session, 'home', 'homelab')).toBe(false)
        expect(sessionMatchesQuery(session, 'homelab', 'homelab')).toBe(true)
    })
})

describe('session search relevance ranking', () => {
    it('gives title hits higher field weight than path hits', () => {
        expect(SESSION_SEARCH_FIELD_WEIGHTS.title).toBeGreaterThan(SESSION_SEARCH_FIELD_WEIGHTS.path)
    })

    it('down-weights terms that match most of the corpus (IDF)', () => {
        // Term matching all docs ≈ log(1+N/(1+N)) small; rare term larger.
        const common = idfForDocumentFrequency(100, 100)
        const rare = idfForDocumentFrequency(100, 1)
        expect(rare).toBeGreaterThan(common)
        expect(common).toBeGreaterThan(0)
    })

    it('ranks Home Assistant above recent path-only /home/ matches for query Home', () => {
        const homeAssistant = makeSession({
            id: 'd755080b',
            updatedAt: 100,
            metadata: {
                path: '/home/heavygee/coding/home-assistant',
                name: 'Home Assistant',
            },
        })
        const recentMeta = makeSession({
            id: 'meta-triage',
            updatedAt: 9_000,
            metadata: {
                path: '/home/heavygee/coding/hapi',
                name: 'meta HAPI triage/problems',
            },
        })
        const olderPeer = makeSession({
            id: 'peer-jobs',
            updatedAt: 8_000,
            metadata: {
                path: '/home/heavygee/coding/hapi/worktrees/jobs',
                name: 'Peer: session-attached jobs',
            },
        })

        const corpus = [recentMeta, olderPeer, homeAssistant]
        const index = buildSessionSearchScoreIndex(corpus, 'Home', () => 'oos')

        expect(index.scores.get(homeAssistant.id) ?? 0).toBeGreaterThan(index.scores.get(recentMeta.id) ?? 0)
        expect(index.scores.get(recentMeta.id) ?? 0).toBeGreaterThan(0)

        const ranked = sortSessionsBySearchRelevance(corpus, index)
        expect(ranked.map((session) => session.id)).toEqual([
            'd755080b',
            'meta-triage',
            'peer-jobs',
        ])
        expect(compareSessionsBySearchRelevance(homeAssistant, recentMeta, index)).toBeLessThan(0)
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
        expect(index.scores.has('path-only')).toBe(false)
    })
})

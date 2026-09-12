import type { SessionSummary } from '@/types/api'
import { isWildcardSearch, matchesSearchQuery } from '@hapi/protocol'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'

/**
 * Field weights for session-list metadata search. Higher = more operator-facing.
 * Path stays fully searchable; ubiquitous segments are down-weighted via IDF.
 */
export const SESSION_SEARCH_FIELD_WEIGHTS = {
    title: 10,
    worktreeLabel: 5,
    summary: 3,
    flavor: 2,
    machine: 2,
    path: 1,
    id: 0.5,
} as const

export type SessionSearchField = keyof typeof SESSION_SEARCH_FIELD_WEIGHTS

/** Extra multiplier when the query sits on an alphanumeric token boundary. */
export const SESSION_SEARCH_BOUNDARY_BONUS = 1.75

type FieldValues = Record<SessionSearchField, string[]>

/** Plain substring (case-insensitive). Inclusion gate — do not use as a score. */
export function searchFieldIncludesQuery(value: string, query: string): boolean {
    if (!query) return true
    return value.toLowerCase().includes(query.toLowerCase())
}

/** True when query sits on an alphanumeric boundary (home matches Home Assistant, not mid-token homelab). */
export function searchFieldHasBoundaryMatch(value: string, query: string): boolean {
    if (!query) return true
    const haystack = value.toLowerCase()
    const needle = query.toLowerCase()
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack)
}

export function tokenizeSearchQuery(query: string): string[] {
    return query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
}

export function collectSessionSearchFields(
    session: SessionSummary,
    machineLabel: string
): FieldValues {
    const pathParts = [
        session.metadata?.path,
        session.metadata?.worktree?.basePath,
        session.metadata?.worktree?.worktreePath,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0)

    return {
        title: [getSessionTitle(session)].filter(Boolean),
        worktreeLabel: [getWorktreeSessionLabel(session) ?? ''].filter(Boolean),
        summary: [session.metadata?.summary?.text ?? ''].filter(Boolean),
        flavor: [session.metadata?.flavor ?? ''].filter(Boolean),
        machine: [machineLabel].filter(Boolean),
        path: pathParts,
        id: [session.id].filter(Boolean),
    }
}

function fieldValuesMatchTerm(values: string[], term: string, wildcard: boolean): boolean {
    if (values.length === 0) return false
    if (wildcard) return values.some((value) => matchesSearchQuery(value, term))
    return values.some((value) => searchFieldIncludesQuery(value, term))
}

function fieldValuesHaveBoundary(values: string[], term: string): boolean {
    return values.some((value) => searchFieldHasBoundaryMatch(value, term))
}

function bestWeightedHitForTerm(
    fields: FieldValues,
    term: string,
    wildcard: boolean
): { weight: number; boundary: boolean } {
    let bestWeight = 0
    let bestBoundary = false
    for (const [field, weight] of Object.entries(SESSION_SEARCH_FIELD_WEIGHTS) as Array<
        [SessionSearchField, number]
    >) {
        const values = fields[field]
        if (!fieldValuesMatchTerm(values, term, wildcard)) continue
        const boundary = wildcard ? true : fieldValuesHaveBoundary(values, term)
        if (weight > bestWeight || (weight === bestWeight && boundary && !bestBoundary)) {
            bestWeight = weight
            bestBoundary = boundary
        }
    }
    return { weight: bestWeight, boundary: bestBoundary }
}

/** Smoothed IDF: rare terms dominate; terms matching most of the corpus contribute little. */
export function idfForDocumentFrequency(documentCount: number, matchingCount: number): number {
    if (documentCount <= 0) return 0
    return Math.log(1 + documentCount / (1 + matchingCount))
}

export function buildSessionSearchIdf(
    corpus: ReadonlyArray<{ fields: FieldValues }>,
    terms: readonly string[],
    wildcard: boolean
): Map<string, number> {
    const idfByTerm = new Map<string, number>()
    const n = corpus.length
    for (const term of terms) {
        let df = 0
        for (const doc of corpus) {
            if (bestWeightedHitForTerm(doc.fields, term, wildcard).weight > 0) {
                df += 1
            }
        }
        idfByTerm.set(term, idfForDocumentFrequency(n, df))
    }
    return idfByTerm
}

export function scoreSessionSearchFields(
    fields: FieldValues,
    terms: readonly string[],
    idfByTerm: ReadonlyMap<string, number>,
    wildcard: boolean
): { matched: boolean; score: number } {
    if (terms.length === 0) return { matched: true, score: 0 }
    let score = 0
    let matchedTerms = 0
    for (const term of terms) {
        const hit = bestWeightedHitForTerm(fields, term, wildcard)
        if (hit.weight <= 0) continue
        matchedTerms += 1
        const boundaryFactor = hit.boundary ? SESSION_SEARCH_BOUNDARY_BONUS : 1
        score += hit.weight * (idfByTerm.get(term) ?? 0) * boundaryFactor
    }
    // AND across terms — every token must hit somewhere.
    if (matchedTerms < terms.length) return { matched: false, score: 0 }
    return { matched: true, score }
}

export type SessionSearchScoreIndex = {
    /** Relevance scores for matched sessions only. */
    scores: Map<string, number>
    /** Explicit match set — never infer membership from score > 0. */
    matchedIds: Set<string>
}

/**
 * Build relevance scores for a corpus. Pass the candidate set you will filter
 * (e.g. time-scoped sessions). Empty query → empty index (caller skips ranking).
 */
export function buildSessionSearchScoreIndex(
    sessions: readonly SessionSummary[],
    query: string,
    resolveMachineLabel: (machineId: string | null) => string
): SessionSearchScoreIndex {
    const scores = new Map<string, number>()
    const matchedIds = new Set<string>()
    const normalized = query.trim().toLowerCase()
    if (!normalized) {
        return { scores, matchedIds }
    }

    const wildcard = isWildcardSearch(normalized)
    const terms = wildcard ? [normalized] : tokenizeSearchQuery(normalized)
    if (terms.length === 0) {
        return { scores, matchedIds }
    }

    const corpus = sessions.map((session) => ({
        session,
        fields: collectSessionSearchFields(
            session,
            resolveMachineLabel(session.metadata?.machineId ?? null)
        ),
    }))
    const idfByTerm = buildSessionSearchIdf(corpus, terms, wildcard)

    for (const { session, fields } of corpus) {
        const { matched, score } = scoreSessionSearchFields(fields, terms, idfByTerm, wildcard)
        if (!matched) continue
        matchedIds.add(session.id)
        scores.set(session.id, score)
    }
    return { scores, matchedIds }
}

export function sessionMatchesSearchIndex(
    sessionId: string,
    index: SessionSearchScoreIndex | null,
    hasTextQuery: boolean
): boolean {
    if (!hasTextQuery) return true
    if (!index) return true
    return index.matchedIds.has(sessionId)
}

export function compareSessionsBySearchRelevance(
    a: SessionSummary,
    b: SessionSummary,
    index: SessionSearchScoreIndex
): number {
    const scoreA = index.scores.get(a.id) ?? 0
    const scoreB = index.scores.get(b.id) ?? 0
    if (scoreB !== scoreA) return scoreB - scoreA
    return b.updatedAt - a.updatedAt
}

export function sortSessionsBySearchRelevance<T extends SessionSummary>(
    sessions: readonly T[],
    index: SessionSearchScoreIndex
): T[] {
    return [...sessions].sort((a, b) => compareSessionsBySearchRelevance(a, b, index))
}

function maxSessionScore(sessions: readonly SessionSummary[], index: SessionSearchScoreIndex): number {
    let max = 0
    for (const session of sessions) {
        const score = index.scores.get(session.id) ?? 0
        if (score > max) max = score
    }
    return max
}

export function rankSessionGroupsBySearchRelevance<T extends {
    sessions: SessionSummary[]
    hasPinnedSession: boolean
    hasActiveSession: boolean
    latestUpdatedAt: number
}>(groups: readonly T[], index: SessionSearchScoreIndex): T[] {
    const ranked = groups.map((group) => ({
        ...group,
        sessions: sortSessionsBySearchRelevance(group.sessions, index),
    }))
    return ranked.sort((a, b) => {
        const scoreA = maxSessionScore(a.sessions, index)
        const scoreB = maxSessionScore(b.sessions, index)
        if (scoreB !== scoreA) return scoreB - scoreA
        // When scores tie, keep the list's usual pinned/active/recency order.
        if (a.hasPinnedSession !== b.hasPinnedSession) {
            return a.hasPinnedSession ? -1 : 1
        }
        if (a.hasActiveSession !== b.hasActiveSession) {
            return a.hasActiveSession ? -1 : 1
        }
        return b.latestUpdatedAt - a.latestUpdatedAt
    })
}

/**
 * Shared boolean matcher (session list, @-mentions, share picker).
 * Substring semantics — partial typing must keep working. Boundary affinity is
 * a ranking bonus in buildSessionSearchScoreIndex, not an exclusion gate.
 */
export function sessionMatchesQuery(
    session: SessionSummary,
    query: string,
    machineLabel: string
): boolean {
    if (!query) return true
    const fields = collectSessionSearchFields(session, machineLabel)
    const values = Object.values(fields).flat()
    if (isWildcardSearch(query)) {
        return values.some((value) => matchesSearchQuery(value, query))
    }
    const terms = tokenizeSearchQuery(query)
    if (terms.length === 0) return true
    return terms.every((term) =>
        values.some((value) => searchFieldIncludesQuery(value, term))
    )
}

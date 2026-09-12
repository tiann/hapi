import type { SessionSummary } from '@/types/api'
import { isWildcardSearch, matchesSearchQuery } from '@hapi/protocol'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getWorktreeSessionLabel } from '@/lib/sessionWorktreeLabel'

/**
 * Field weights for session-list metadata search. Higher = more operator-facing.
 * Path stays searchable (weight 1) so `/home/...` queries still work; ubiquitous
 * path segments are down-weighted via IDF rather than stripped.
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

export type SessionSearchFields = Record<SessionSearchField, string>

/** Plain-query match on an alphanumeric token boundary (avoids home⊂homelab). */
export function searchFieldMatchesQuery(value: string, query: string): boolean {
    if (!query) return true
    const haystack = value.toLowerCase()
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
): SessionSearchFields {
    const pathParts = [
        session.metadata?.path,
        session.metadata?.worktree?.basePath,
        session.metadata?.worktree?.worktreePath,
    ].filter((part): part is string => typeof part === 'string' && part.length > 0)

    return {
        title: getSessionTitle(session),
        worktreeLabel: getWorktreeSessionLabel(session) ?? '',
        summary: session.metadata?.summary?.text ?? '',
        flavor: session.metadata?.flavor ?? '',
        machine: machineLabel,
        path: pathParts.join('\n'),
        id: session.id,
    }
}

function fieldMatchesTerm(value: string, term: string, wildcard: boolean): boolean {
    if (!value) return false
    if (wildcard) return matchesSearchQuery(value, term)
    return searchFieldMatchesQuery(value, term)
}

function bestFieldWeightForTerm(fields: SessionSearchFields, term: string, wildcard: boolean): number {
    let best = 0
    for (const [field, weight] of Object.entries(SESSION_SEARCH_FIELD_WEIGHTS) as Array<
        [SessionSearchField, number]
    >) {
        if (weight <= best) continue
        if (fieldMatchesTerm(fields[field], term, wildcard)) {
            best = weight
        }
    }
    return best
}

/** Smoothed IDF: rare terms dominate; terms matching most of the corpus ≈ noop. */
export function idfForDocumentFrequency(documentCount: number, matchingCount: number): number {
    if (documentCount <= 0) return 0
    return Math.log(1 + documentCount / (1 + matchingCount))
}

export function buildSessionSearchIdf(
    corpus: ReadonlyArray<{ fields: SessionSearchFields }>,
    terms: readonly string[],
    wildcard: boolean
): Map<string, number> {
    const idfByTerm = new Map<string, number>()
    const n = corpus.length
    for (const term of terms) {
        let df = 0
        for (const doc of corpus) {
            if (bestFieldWeightForTerm(doc.fields, term, wildcard) > 0) {
                df += 1
            }
        }
        idfByTerm.set(term, idfForDocumentFrequency(n, df))
    }
    return idfByTerm
}

export function scoreSessionSearchFields(
    fields: SessionSearchFields,
    terms: readonly string[],
    idfByTerm: ReadonlyMap<string, number>,
    wildcard: boolean
): number {
    if (terms.length === 0) return 0
    let score = 0
    let matchedTerms = 0
    for (const term of terms) {
        const fieldWeight = bestFieldWeightForTerm(fields, term, wildcard)
        if (fieldWeight <= 0) continue
        matchedTerms += 1
        score += fieldWeight * (idfByTerm.get(term) ?? 0)
    }
    // Require every query term to hit somewhere — same as AND for multi-word search.
    if (matchedTerms < terms.length) return 0
    return score
}

export type SessionSearchScoreIndex = {
    scores: Map<string, number>
}

/**
 * Build relevance scores for a corpus. Sessions with score 0 do not match.
 * Pass the same candidate set you will filter (e.g. time-filtered sessions).
 */
export function buildSessionSearchScoreIndex(
    sessions: readonly SessionSummary[],
    query: string,
    resolveMachineLabel: (machineId: string | null) => string
): SessionSearchScoreIndex {
    const normalized = query.trim().toLowerCase()
    const scores = new Map<string, number>()
    if (!normalized) {
        return { scores }
    }

    const wildcard = isWildcardSearch(normalized)
    const terms = wildcard ? [normalized] : tokenizeSearchQuery(normalized)
    if (terms.length === 0) {
        return { scores }
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
        const score = scoreSessionSearchFields(fields, terms, idfByTerm, wildcard)
        if (score > 0) {
            scores.set(session.id, score)
        }
    }
    return { scores }
}

export function sessionMatchesSearchScoreIndex(
    sessionId: string,
    index: SessionSearchScoreIndex | null,
    hasTextQuery: boolean
): boolean {
    if (!hasTextQuery) return true
    if (!index) return true
    return (index.scores.get(sessionId) ?? 0) > 0
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
        const scoreA = Math.max(0, ...a.sessions.map((session) => index.scores.get(session.id) ?? 0))
        const scoreB = Math.max(0, ...b.sessions.map((session) => index.scores.get(session.id) ?? 0))
        if (scoreB !== scoreA) return scoreB - scoreA
        // Preserve existing tie-breaks when scores are equal (e.g. empty query path unused).
        if (a.hasPinnedSession !== b.hasPinnedSession) {
            return a.hasPinnedSession ? -1 : 1
        }
        if (a.hasActiveSession !== b.hasActiveSession) {
            return a.hasActiveSession ? -1 : 1
        }
        return b.latestUpdatedAt - a.latestUpdatedAt
    })
}

/** Boolean match used by callers that only need include/exclude. */
export function sessionMatchesQuery(
    session: SessionSummary,
    query: string,
    machineLabel: string
): boolean {
    if (!query) return true
    const fields = collectSessionSearchFields(session, machineLabel)
    const wildcard = isWildcardSearch(query)
    if (wildcard) {
        return Object.values(fields).some((value) => value && matchesSearchQuery(value, query))
    }
    const terms = tokenizeSearchQuery(query)
    if (terms.length === 0) return true
    return terms.every((term) => bestFieldWeightForTerm(fields, term, false) > 0)
}

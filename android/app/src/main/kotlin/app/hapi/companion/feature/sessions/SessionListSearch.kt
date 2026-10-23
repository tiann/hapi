package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary

/**
 * Session-list relevance search — port of `web/src/lib/sessionListSearch.ts`
 * (+ `shared/src/search.ts` wildcard matcher). Field weights + boundary and
 * title-phrase bonuses rank matches; substring inclusion stays the gate.
 * Pure Kotlin so JVM tests pin the semantics to the web reference.
 */
enum class SessionSearchField(val weight: Double) {
    TITLE(10.0),
    WORKTREE_LABEL(5.0),
    SUMMARY(3.0),
    FLAVOR(2.0),
    MACHINE(2.0),
    PATH(1.0),
    ID(0.5),
}

/** Per-field searchable values for one session. Empty values are dropped. */
data class SessionSearchFields(
    val title: List<String>,
    val worktreeLabel: List<String>,
    val summary: List<String>,
    val flavor: List<String>,
    val machine: List<String>,
    val path: List<String>,
    val id: List<String>,
) {
    operator fun get(field: SessionSearchField): List<String> = when (field) {
        SessionSearchField.TITLE -> title
        SessionSearchField.WORKTREE_LABEL -> worktreeLabel
        SessionSearchField.SUMMARY -> summary
        SessionSearchField.FLAVOR -> flavor
        SessionSearchField.MACHINE -> machine
        SessionSearchField.PATH -> path
        SessionSearchField.ID -> id
    }

    val allValues: List<String>
        get() = SessionSearchField.entries.flatMap { get(it) }
}

/** Relevance scores for the matched subset of a corpus. */
data class SessionSearchScoreIndex(
    /** Scores for matched sessions only — never infer membership from score > 0. */
    val scores: Map<String, Double>,
    val matchedIds: Set<String>,
)

object SessionListSearch {
    /** Extra multiplier when the query sits on an alphanumeric token boundary. */
    const val BOUNDARY_BONUS = 1.75

    /** Contiguous full-query phrase in the title (multi-word queries). */
    const val TITLE_PHRASE_BONUS = 25.0

    /** Exact title match (normalized). */
    const val EXACT_TITLE_BONUS = 50.0

    /** Whether a query should be interpreted as a wildcard pattern. */
    fun isWildcardSearch(query: String): Boolean = query.contains('*') || query.contains('?')

    /** Plain substring (case-insensitive). Inclusion gate — do not use as a score. */
    fun searchFieldIncludesQuery(value: String, query: String): Boolean {
        if (query.isEmpty()) return true
        return value.lowercase().contains(query.lowercase())
    }

    /** True when the query sits on an alphanumeric boundary (`home` matches "Home Assistant", not mid-token `homelab`). */
    fun searchFieldHasBoundaryMatch(value: String, query: String): Boolean {
        if (query.isEmpty()) return true
        val haystack = value.lowercase()
        val needle = query.lowercase()
        // Same shape as the web regex `(?:^|[^a-z0-9])needle(?:[^a-z0-9]|$)`:
        // Kotlin Regex.escape backslashes every non-letter/digit, which
        // java.util.regex always reads as a literal.
        val pattern = Regex("(?:^|[^a-z0-9])${Regex.escape(needle)}(?:[^a-z0-9]|$)")
        return pattern.containsMatchIn(haystack)
    }

    fun tokenizeSearchQuery(query: String): List<String> =
        query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

    /**
     * Wildcard matcher on code points (`Array.from` in the JS reference, not
     * UTF-16 units) — `?` eats one code point, `*` any run.
     */
    fun matchesWildcard(value: String, pattern: String): Boolean {
        val input = value.lowercase().codePoints().toArray()
        val tokens = pattern.lowercase().codePoints().toArray()
        val star = '*'.code
        val question = '?'.code
        var inputIndex = 0
        var tokenIndex = 0
        var starIndex = -1
        var retryInputIndex = 0

        while (inputIndex < input.size) {
            val token = tokens.getOrNull(tokenIndex)
            if (token != null && (token == question || token == input[inputIndex])) {
                inputIndex++
                tokenIndex++
            } else if (token == star) {
                starIndex = tokenIndex++
                retryInputIndex = inputIndex
            } else if (starIndex >= 0) {
                tokenIndex = starIndex + 1
                retryInputIndex += 1
                inputIndex = retryInputIndex
            } else {
                return false
            }
        }

        while (tokenIndex < tokens.size && tokens[tokenIndex] == star) {
            tokenIndex++
        }
        return tokenIndex == tokens.size
    }

    /** Match a value using plain substring semantics or supported wildcards. */
    fun matchesSearchQuery(value: String, query: String): Boolean {
        val normalizedQuery = query.trim()
        if (normalizedQuery.isEmpty()) return true
        if (!isWildcardSearch(normalizedQuery)) {
            return value.lowercase().contains(normalizedQuery.lowercase())
        }
        return matchesWildcard(value, normalizedQuery)
    }

    /**
     * `getWorktreeSessionLabel` (`web/src/lib/sessionWorktreeLabel.ts`): short
     * worktree name, falling back to the last segment of the worktree path.
     */
    fun worktreeLabel(summary: SessionSummary): String? {
        val worktree = summary.metadata?.worktree ?: return null
        val name = worktree.name.trim()
        if (name.isNotEmpty()) return name
        val path = (worktree.worktreePath ?: summary.metadata?.path ?: "").trimEnd('/', '\\')
        return path.split(Regex("[\\\\/]+")).lastOrNull { it.isNotEmpty() }
    }

    fun collectSessionSearchFields(
        summary: SessionSummary,
        machineLabel: String,
    ): SessionSearchFields {
        val metadata = summary.metadata
        val pathParts = buildList {
            metadata?.path?.takeIf { it.isNotEmpty() }?.let(::add)
            metadata?.worktree?.basePath?.takeIf { it.isNotEmpty() }?.let(::add)
            metadata?.worktree?.worktreePath?.takeIf { it.isNotEmpty() }?.let(::add)
        }
        return SessionSearchFields(
            title = listOf(SessionListViewModel.sessionTitle(summary)).filter { it.isNotEmpty() },
            worktreeLabel = listOf(worktreeLabel(summary) ?: "").filter { it.isNotEmpty() },
            summary = listOf(metadata?.summary?.text ?: "").filter { it.isNotEmpty() },
            flavor = listOf(metadata?.flavor ?: "").filter { it.isNotEmpty() },
            machine = listOf(machineLabel).filter { it.isNotEmpty() },
            path = pathParts,
            id = listOf(summary.id).filter { it.isNotEmpty() },
        )
    }

    private fun fieldValuesMatchTerm(values: List<String>, term: String, wildcard: Boolean): Boolean {
        if (values.isEmpty()) return false
        if (wildcard) return values.any { matchesSearchQuery(it, term) }
        return values.any { searchFieldIncludesQuery(it, term) }
    }

    private fun fieldValuesHaveBoundary(values: List<String>, term: String): Boolean =
        values.any { searchFieldHasBoundaryMatch(it, term) }

    private data class WeightedHit(val weight: Double, val boundary: Boolean)

    private fun bestWeightedHitForTerm(
        fields: SessionSearchFields,
        term: String,
        wildcard: Boolean,
    ): WeightedHit {
        var best = WeightedHit(weight = 0.0, boundary = false)
        var bestContribution = 0.0
        for (field in SessionSearchField.entries) {
            val values = fields[field]
            if (!fieldValuesMatchTerm(values, term, wildcard)) continue
            val boundary = wildcard || fieldValuesHaveBoundary(values, term)
            val contribution = field.weight * if (boundary) BOUNDARY_BONUS else 1.0
            // Compare post-bonus contribution so a boundary hit on a lighter
            // field can beat a mid-token hit on a heavier one.
            if (contribution > bestContribution) {
                bestContribution = contribution
                best = WeightedHit(weight = field.weight, boundary = boundary)
            }
        }
        return best
    }

    /** Exact title or contiguous multi-word phrase in the title. */
    fun titlePhraseBonus(titles: List<String>, normalizedQuery: String): Double {
        if (normalizedQuery.isEmpty() || titles.isEmpty()) return 0.0
        var best = 0.0
        for (title in titles) {
            val normalizedTitle = title.trim().lowercase()
            if (normalizedTitle.isEmpty()) continue
            if (normalizedTitle == normalizedQuery) {
                best = maxOf(best, EXACT_TITLE_BONUS)
                continue
            }
            // Contiguous phrase only matters for multi-word queries (single
            // tokens already get field weight + boundary).
            if (normalizedQuery.contains(' ') && searchFieldIncludesQuery(normalizedTitle, normalizedQuery)) {
                best = maxOf(best, TITLE_PHRASE_BONUS)
            }
        }
        return best
    }

    data class ScoreResult(val matched: Boolean, val score: Double)

    fun scoreSessionSearchFields(
        fields: SessionSearchFields,
        terms: List<String>,
        normalizedQuery: String,
        wildcard: Boolean,
    ): ScoreResult {
        if (terms.isEmpty()) return ScoreResult(matched = true, score = 0.0)
        var score = 0.0
        var matchedTerms = 0
        for (term in terms) {
            val hit = bestWeightedHitForTerm(fields, term, wildcard)
            if (hit.weight <= 0.0) continue
            matchedTerms += 1
            score += hit.weight * if (hit.boundary) BOUNDARY_BONUS else 1.0
        }
        // AND across terms — every token must hit somewhere.
        if (matchedTerms < terms.size) return ScoreResult(matched = false, score = 0.0)
        if (!wildcard) {
            score += titlePhraseBonus(fields.title, normalizedQuery)
        }
        return ScoreResult(matched = true, score = score)
    }

    /**
     * Build relevance scores for a corpus. Pass the candidate set you will
     * filter. Blank query → empty index (caller skips ranking).
     */
    fun buildSessionSearchScoreIndex(
        sessions: List<SessionSummary>,
        query: String,
        resolveMachineLabel: (machineId: String?) -> String,
    ): SessionSearchScoreIndex {
        val normalized = query.trim().lowercase()
        if (normalized.isEmpty()) return SessionSearchScoreIndex(emptyMap(), emptySet())

        val wildcard = isWildcardSearch(normalized)
        val terms = if (wildcard) listOf(normalized) else tokenizeSearchQuery(normalized)
        if (terms.isEmpty()) return SessionSearchScoreIndex(emptyMap(), emptySet())

        val scores = mutableMapOf<String, Double>()
        val matchedIds = mutableSetOf<String>()
        for (session in sessions) {
            val fields = collectSessionSearchFields(session, resolveMachineLabel(session.metadata?.machineId))
            val result = scoreSessionSearchFields(fields, terms, normalized, wildcard)
            if (!result.matched) continue
            matchedIds += session.id
            scores[session.id] = result.score
        }
        return SessionSearchScoreIndex(scores, matchedIds)
    }

    fun sessionMatchesSearchIndex(
        sessionId: String,
        index: SessionSearchScoreIndex?,
        hasTextQuery: Boolean,
    ): Boolean {
        if (!hasTextQuery) return true
        if (index == null) return true
        return sessionId in index.matchedIds
    }

    fun compareSessionsBySearchRelevance(
        a: SessionSummary,
        b: SessionSummary,
        index: SessionSearchScoreIndex,
    ): Int {
        val scoreA = index.scores[a.id] ?: 0.0
        val scoreB = index.scores[b.id] ?: 0.0
        if (scoreA != scoreB) return scoreB.compareTo(scoreA)
        return b.updatedAt.compareTo(a.updatedAt)
    }

    fun sortSessionsBySearchRelevance(
        sessions: List<SessionSummary>,
        index: SessionSearchScoreIndex,
    ): List<SessionSummary> = sessions.sortedWith { a, b -> compareSessionsBySearchRelevance(a, b, index) }

    /**
     * Relevance sort that keeps project-pinned rows contiguous ahead of
     * ordinary rows — flat score sort would interleave them and the renderer
     * draws a divider on every transition.
     */
    fun sortSessionsBySearchRelevancePreservingPins(
        sessions: List<SessionSummary>,
        index: SessionSearchScoreIndex,
    ): List<SessionSummary> {
        val pinned = sessions.filter { it.pinned == true }
        val ordinary = sessions.filter { it.pinned != true }
        return sortSessionsBySearchRelevance(pinned, index) + sortSessionsBySearchRelevance(ordinary, index)
    }

    /**
     * Shared boolean matcher (session list, mention pickers): substring
     * semantics, multi-word queries AND across terms.
     */
    fun sessionMatchesQuery(
        summary: SessionSummary,
        query: String,
        machineLabel: String,
    ): Boolean {
        if (query.isEmpty()) return true
        val fields = collectSessionSearchFields(summary, machineLabel)
        val values = fields.allValues
        if (isWildcardSearch(query)) {
            return values.any { matchesSearchQuery(it, query) }
        }
        val terms = tokenizeSearchQuery(query)
        if (terms.isEmpty()) return true
        return terms.all { term -> values.any { searchFieldIncludesQuery(it, term) } }
    }
}

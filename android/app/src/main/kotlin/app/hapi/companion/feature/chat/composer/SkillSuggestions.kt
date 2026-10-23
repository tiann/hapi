package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.SkillSummary
import kotlin.math.floor
import kotlin.math.min

/**
 * Pure logic behind the composer's `$` skills autocomplete (web
 * `useSkills` ranking): trigger detection + scoring. The UI rows render in
 * `ChatComposer`'s autocomplete dropdown; `ChatViewModel` drives these over
 * the `GET /skills` RPC result and the [RecentSkills] timestamps.
 *
 * Like the `/` trigger, the query is the whole input as a single `$`-led
 * token (the web ranks the active word at the cursor; the single-token
 * composer keeps the simpler whole-input rule shared with slash).
 */
object SkillSuggestions {

    /**
     * The active skills query: non-null while the composer text is a single
     * `$`-led token at the start of input (`$`, `$co`, `$code-review`) — any
     * whitespace closes the menu. Returns the text after `$` (may be empty).
     */
    fun queryOf(text: String): String? {
        if (!text.startsWith("$")) return null
        val token = text.substring(1)
        if (token.any { it.isWhitespace() }) return null
        return token
    }

    /**
     * Case-insensitive scoring, the web's `getSkillSuggestions` ranking:
     * an empty [query] ranks by recency desc then name; otherwise
     * exact = 0, prefix = 1, contains = 2, and a levenshtein within
     * `max(2, query length / 2)` scores `3 + distance` — everything else
     * drops. Ties break recency desc, then name.
     */
    fun filter(
        skills: List<SkillSummary>,
        query: String,
        recent: Map<String, Long> = emptyMap(),
    ): List<SkillSummary> {
        if (query.isEmpty()) {
            return skills
                .map { IScored(it, it.name.lowercase(), 0) }
                .sortedWith(
                    compareByDescending<IScored> { recent[it.key] ?: 0L }
                        .thenBy { it.key },
                )
                .map { it.skill }
        }
        val term = query.lowercase()
        return skills
            .mapNotNull { skill ->
                val name = skill.name.lowercase()
                val score = when {
                    name == term -> 0
                    name.startsWith(term) -> 1
                    name.contains(term) -> 2
                    else -> {
                        val limit = maxEdits(term.length)
                        val distance = levenshtein(term, name, limit)
                        if (distance > limit) return@mapNotNull null else 3 + distance
                    }
                }
                IScored(skill, skill.name.lowercase(), score)
            }
            .sortedWith(
                compareBy<IScored> { it.score }
                    .thenByDescending { recent[it.key] ?: 0L }
                    .thenBy { it.key },
            )
            .map { it.skill }
    }

    /** Web threshold: `max(2, floor(len / 2))` tolerated edits. */
    internal fun maxEdits(queryLength: Int): Int = maxOf(2, floor(queryLength / 2.0).toInt())

    /**
     * Classic DP levenshtein with a row-min early exit once every cell in a
     * row exceeds [limit] (the distance can only grow), so long skill lists
     * stay cheap. `limit` beyond the row budget short-circuits at `limit + 1`.
     */
    internal fun levenshtein(a: String, b: String, limit: Int): Int {
        if (a == b) return 0
        if (a.isEmpty()) return b.length
        if (b.isEmpty()) return a.length
        var previous = IntArray(a.length + 1) { it }
        for (j in 1..b.length) {
            val current = IntArray(a.length + 1)
            current[0] = j
            var rowMin = current[0]
            for (i in 1..a.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                current[i] = min(
                    min(previous[i] + 1, current[i - 1] + 1),
                    previous[i - 1] + cost,
                )
                rowMin = min(rowMin, current[i])
            }
            if (rowMin > limit) return limit + 1
            previous = current
        }
        return previous[a.length]
    }

    private class IScored(val skill: SkillSummary, val key: String, val score: Int)
}

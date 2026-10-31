package app.hapi.companion.feature.chat.composer

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Web `recent-skills.ts` twin: last-used epoch per skill name, capped at
 * 200 entries, ranking the `$` menu's empty-query order (and tie-breaking
 * the scored order). Names are stored lowercased — the same normalization
 * [SkillSuggestions.filter] keys its recency lookups on — so case
 * differences cannot split or lose ranking history. Names absent from the
 * map are "never used" — rank last, then name order. Production persists
 * over the app-wide prefs DataStore (`di/DataStoreRecentSkills`); tests use
 * [InMemoryRecentSkills].
 */
interface RecentSkills {

    /** Latest-use timestamps by skill name (lowercase key); empty until something is used. */
    val timestamps: Flow<Map<String, Long>>

    /** Record a use at [at]; the newest [RecentSkillsLogic.MAX_ENTRIES] survive. */
    suspend fun markUsed(name: String, at: Long)
}

object RecentSkillsLogic {

    /** Web keeps the 200 most recent entries. */
    const val MAX_ENTRIES = 200

    /**
     * Pure step behind [RecentSkills.markUsed] — newest-first cap at 200.
     * The key is [String.lowercase]-normalized to match the lookup side
     * ([SkillSuggestions.filter]), so `Zeta` and `zeta` share one entry.
     */
    fun advance(current: Map<String, Long>, name: String, at: Long): Map<String, Long> {
        val key = name.lowercase()
        if (key.isEmpty()) return current
        return (current + (key to at)).entries
            .sortedByDescending { it.value }
            .take(MAX_ENTRIES)
            .associate { it.toPair() }
    }
}

/** In-memory [RecentSkills] — tests, previews, and stores without prefs. */
class InMemoryRecentSkills : RecentSkills {

    private val _timestamps = MutableStateFlow<Map<String, Long>>(emptyMap())

    override val timestamps: StateFlow<Map<String, Long>> = _timestamps.asStateFlow()

    override suspend fun markUsed(name: String, at: Long) {
        _timestamps.value = RecentSkillsLogic.advance(_timestamps.value, name, at)
    }
}

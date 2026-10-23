package app.hapi.companion.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.hapi.companion.feature.chat.composer.RecentSkills
import app.hapi.companion.feature.chat.composer.RecentSkillsLogic
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Process-wide recent-skills DataStore. Separate from `hapi_prefs` (roster /
 * theme) and `chat_drafts` (bursty) — this one writes only on skill picks.
 */
internal val Context.recentSkillsDataStore: DataStore<Preferences> by preferencesDataStore(name = "recent_skills")

/**
 * [RecentSkills] over a Preferences DataStore: one string key holding
 * `epoch \u001F name` lines, newest-first, capped at
 * [RecentSkillsLogic.MAX_ENTRIES]. Unreadable/corrupt lines drop silently —
 * recency ranking degrades to name order, nothing crashes.
 */
class DataStoreRecentSkills(
    private val dataStore: DataStore<Preferences>,
) : RecentSkills {

    override val timestamps: Flow<Map<String, Long>> =
        dataStore.data.map { prefs -> decode(prefs[KEY]) }

    override suspend fun markUsed(name: String, at: Long) {
        val next = RecentSkillsLogic.advance(timestamps.first(), name, at)
        dataStore.edit { prefs ->
            prefs[KEY] = encode(next)
        }
    }

    private fun encode(map: Map<String, Long>): String = map.entries
        .sortedByDescending { it.value }
        .joinToString("\n") { "${it.value}\u001F${it.key}" }

    private fun decode(raw: String?): Map<String, Long> {
        if (raw.isNullOrEmpty()) return emptyMap()
        val parsed = mutableListOf<Pair<Long, String>>()
        for (line in raw.lineSequence()) {
            val separator = line.lastIndexOf('\u001F')
            if (separator <= 0) continue
            val epoch = line.substring(0, separator).toLongOrNull() ?: continue
            val name = line.substring(separator + 1)
            if (name.isNotEmpty()) parsed += epoch to name
        }
        // Newest-first cap, same as the write path (guards legacy over-writes).
        return parsed
            .sortedByDescending { it.first }
            .take(RecentSkillsLogic.MAX_ENTRIES)
            .associate { (epoch, name) -> name to epoch }
    }

    private companion object {
        val KEY = stringPreferencesKey("recent_skills")
    }
}

package app.hapi.companion.feature.chat.composer

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** Most-recent-first, local to one Hub and namespace. */
interface RecentSkills {
    val names: Flow<List<String>>
    suspend fun record(name: String)
}

internal fun skillNameKey(name: String): String = name.trim().lowercase()

internal class DataStoreRecentSkills(
    private val dataStore: DataStore<Preferences>,
    hubUrl: String,
    namespace: String,
) : RecentSkills {
    private val key = stringPreferencesKey("recent_skills:${hubUrl.length}:$hubUrl:$namespace")

    override val names = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { decode(it[key]) }
        .distinctUntilChanged()

    override suspend fun record(name: String) {
        val normalized = skillNameKey(name)
        if (normalized.isEmpty()) return
        dataStore.edit { prefs ->
            val updated = (listOf(normalized) + decode(prefs[key]).filterNot { it == normalized }).take(LIMIT)
            prefs[key] = Json.encodeToString(updated)
        }
    }

    private fun decode(encoded: String?): List<String> {
        if (encoded == null) return emptyList()
        return try {
            Json.decodeFromString<List<String>>(encoded).take(LIMIT)
        } catch (_: SerializationException) {
            emptyList()
        }
    }

    private companion object {
        const val LIMIT = 200
    }
}

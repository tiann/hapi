package app.hapi.companion.feature.newsession

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.protocol.wire.HapiJson
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable

/**
 * Create-form persistence: last-used machine + per-machine recent paths
 * (web `useRecentPaths`, localStorage → DataStore here) and the in-progress
 * form draft (web `newSessionFormDraft.ts`, sessionStorage → DataStore) so
 * backing out of the screen loses nothing.
 */
@Serializable
data class NewSessionPrefsData(
    val lastMachineId: String? = null,
    /** Machine id → most-recent-first spawn directories (cap [NewSessionLogic.MAX_RECENT_PATHS]). */
    val recentPaths: Map<String, List<String>> = emptyMap(),
)

interface NewSessionPrefs {
    suspend fun readPrefs(): NewSessionPrefsData
    suspend fun writePrefs(data: NewSessionPrefsData)

    /** Null when no draft is stored (or it fails to decode). */
    suspend fun readDraft(): NewSessionForm?
    suspend fun writeDraft(draft: NewSessionForm)
    suspend fun clearDraft()
}

/**
 * DataStore-backed production impl. Both blobs are JSON under single string
 * keys in the app-wide `hapi_prefs` store; corrupt data degrades to defaults
 * (the roster storage sets the same precedent).
 */
class DataStoreNewSessionPrefs(
    private val dataStore: DataStore<Preferences>,
) : NewSessionPrefs {

    override suspend fun readPrefs(): NewSessionPrefsData =
        decode(read(PREFS_KEY), NewSessionPrefsData.serializer()) ?: NewSessionPrefsData()

    override suspend fun writePrefs(data: NewSessionPrefsData) {
        dataStore.edit { it[PREFS_KEY] = HapiJson.encodeToString(NewSessionPrefsData.serializer(), data) }
    }

    override suspend fun readDraft(): NewSessionForm? =
        decode(read(DRAFT_KEY), NewSessionForm.serializer())

    override suspend fun writeDraft(draft: NewSessionForm) {
        dataStore.edit { it[DRAFT_KEY] = HapiJson.encodeToString(NewSessionForm.serializer(), draft) }
    }

    override suspend fun clearDraft() {
        dataStore.edit { it.remove(DRAFT_KEY) }
    }

    private suspend fun read(key: Preferences.Key<String>): String? =
        dataStore.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .first()[key]

    private fun <T> decode(raw: String?, serializer: kotlinx.serialization.KSerializer<T>): T? {
        if (raw.isNullOrEmpty()) return null
        return try {
            HapiJson.decodeFromString(serializer, raw)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        val PREFS_KEY: Preferences.Key<String> = stringPreferencesKey("new_session_prefs")
        val DRAFT_KEY: Preferences.Key<String> = stringPreferencesKey("new_session_draft")
    }
}

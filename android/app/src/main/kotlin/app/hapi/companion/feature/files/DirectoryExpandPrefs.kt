package app.hapi.companion.feature.files

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * Process-wide directory-expand DataStore. Separate from `hapi_prefs` so the
 * bursty per-toggle writes (web persists on every expand/collapse) never
 * contend with the settings file (chat-drafts precedent).
 */
internal val Context.filesDirExpandDataStore: DataStore<Preferences> by preferencesDataStore(name = "files_dir_expand")

/**
 * Browse-tree expanded-directory set — the Android twin of web sessionStorage
 * `hapi-dir-expanded-{sessionId}` (web `DirectoryTree.tsx`: a JSON string
 * array of session-root-relative paths, default root-only, written on every
 * expand/collapse). Web keys by session only because a browser tab talks to
 * one hub; Android pairs several hubs, so entries are scoped `hub:session`
 * like the drafts store. Divergence: DataStore is durable where web's
 * sessionStorage dies with the tab — a longer-lived expand memory, not a
 * behavior web users rely on losing. Corrupt values degrade to the default
 * root-only set.
 */
class DirectoryExpandPrefs(private val dataStore: DataStore<Preferences>) {

    fun expandedPaths(hubUrl: String, sessionId: String): Flow<Set<String>> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> decode(prefs[key(hubUrl, sessionId)]) }
        .distinctUntilChanged()

    suspend fun setExpandedPaths(hubUrl: String, sessionId: String, paths: Set<String>) {
        dataStore.edit { prefs -> prefs[key(hubUrl, sessionId)] = encode(paths) }
    }

    private fun key(hubUrl: String, sessionId: String): Preferences.Key<String> =
        stringPreferencesKey("expanded:$hubUrl:$sessionId")

    companion object {
        fun encode(paths: Set<String>): String =
            JsonArray(paths.map { JsonPrimitive(it) }).toString()

        /** Non-array or non-string payloads degrade to the default (web `readExpanded`). */
        fun decode(raw: String?): Set<String> {
            if (raw == null) return emptySet()
            val array = try {
                Json.parseToJsonElement(raw)
            } catch (_: Exception) {
                return emptySet()
            }
            if (array !is JsonArray) return emptySet()
            val paths = array.mapNotNull { element ->
                (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            }
            return paths.toSet()
        }
    }
}

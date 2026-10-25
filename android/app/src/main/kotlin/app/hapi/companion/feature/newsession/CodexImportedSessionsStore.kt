package app.hapi.companion.feature.newsession

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.protocol.wire.HapiJson
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * Which local Codex threads have already been imported, and when (epoch ms) —
 * the Android twin of `web/src/lib/codexImportedSessions.ts` (localStorage
 * `hapi.codexImportedSessions` → a DataStore JSON blob here). Powers the
 * dialog's "Imported" badge and the selection-clearing rule after a bulk
 * import. Added for slice A (codex session import).
 */
@Serializable
data class CodexImportedSessionsData(
    /** Codex thread id → import timestamp (epoch ms). */
    val importedAt: Map<String, Long> = emptyMap(),
)

interface CodexImportedSessionsStore {
    /** Live snapshot; starts empty and never throws. */
    val markers: StateFlow<Map<String, Long>>

    /** Records [ids] as imported at [importedAt]; blank ids are skipped (web trims). */
    suspend fun markImported(ids: List<String>, importedAt: Long = System.currentTimeMillis())

    /** Removes one marker — no-op when absent (web writes only `if id in map`). */
    suspend fun clearMarker(id: String)
}

/** In-memory twin (tests, and the holder default before slice wiring). */
class MemoryCodexImportedSessionsStore : CodexImportedSessionsStore {
    private val mutable = MutableStateFlow<Map<String, Long>>(emptyMap())
    override val markers: StateFlow<Map<String, Long>> = mutable.asStateFlow()

    override suspend fun markImported(ids: List<String>, importedAt: Long) {
        val additions = ids.mapNotNull { it.trim().ifEmpty { null } }.associateWith { importedAt }
        if (additions.isEmpty()) return
        mutable.value = mutable.value + additions
    }

    override suspend fun clearMarker(id: String) {
        if (id in mutable.value) mutable.value = mutable.value - id
    }
}

/**
 * DataStore-backed production impl: one JSON blob under a string key in the
 * app-wide `hapi_prefs` store (same precedent as [DataStoreNewSessionPrefs]).
 * Corrupt data degrades to empty markers. The web's "drop non-finite
 * timestamps on read" guard has no analogue: JSON numbers cannot encode
 * NaN/Infinity, so a decoded `Long` is always finite.
 */
class DataStoreCodexImportedSessionsStore(
    private val dataStore: DataStore<Preferences>,
    scope: CoroutineScope,
) : CodexImportedSessionsStore {

    private val mutable = MutableStateFlow<Map<String, Long>>(emptyMap())

    override val markers: StateFlow<Map<String, Long>> = mutable.asStateFlow()

    init {
        scope.launch {
            dataStore.data
                .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
                .map { prefs -> decode(prefs[KEY]) }
                .collect { mutable.value = it }
        }
    }

    override suspend fun markImported(ids: List<String>, importedAt: Long) {
        val additions = ids.mapNotNull { it.trim().ifEmpty { null } }.associateWith { importedAt }
        if (additions.isEmpty()) return
        dataStore.edit { prefs ->
            val next = decode(prefs[KEY]).let { it + additions }
            prefs[KEY] = HapiJson.encodeToString(CodexImportedSessionsData.serializer(), CodexImportedSessionsData(next))
        }
    }

    override suspend fun clearMarker(id: String) {
        dataStore.edit { prefs ->
            val current = decode(prefs[KEY])
            if (id in current) {
                val next = current - id
                prefs[KEY] = HapiJson.encodeToString(CodexImportedSessionsData.serializer(), CodexImportedSessionsData(next))
            }
        }
    }

    private fun decode(raw: String?): Map<String, Long> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return try {
            HapiJson.decodeFromString(CodexImportedSessionsData.serializer(), raw).importedAt
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private companion object {
        val KEY: Preferences.Key<String> = stringPreferencesKey("codex_imported_sessions")
    }
}

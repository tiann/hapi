package app.hapi.companion.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.hapi.companion.feature.sessions.SessionGroupCollapsePrefs
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Process-wide group-collapse DataStore. Separate from `hapi_prefs` so the
 * bursty per-toggle writes never contend with the settings file
 * (`chat_drafts` precedent).
 */
internal val Context.sessionGroupCollapseDataStore: DataStore<Preferences> by preferencesDataStore(name = "session_group_collapse")

/**
 * [SessionGroupCollapsePrefs] over a Preferences DataStore: one JSON blob per
 * hub. The group key is `machineId::directory`, which only namespaces within
 * one hub — two hubs may run the same machine id, so the DataStore key is
 * hub-scoped (`collapsed:$hubKey`, drafts-store convention). Unreadable prefs
 * degrade to no overrides (ThemePrefs precedent).
 */
internal class DataStoreSessionGroupCollapsePrefs(
    private val dataStore: DataStore<Preferences>,
) : SessionGroupCollapsePrefs {

    override fun overrides(hubKey: String): Flow<Map<String, Boolean>> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> SessionGroupCollapsePrefs.decode(prefs[key(hubKey)]) }
        .distinctUntilChanged()

    override suspend fun setOverride(hubKey: String, groupKey: String, collapsed: Boolean) {
        dataStore.edit { prefs ->
            // Store explicit values both ways (web `toggleGroup` semantics):
            // a `false` override is a real choice, not "back to default" —
            // dropping it would let a quiet group re-fold on the next collect.
            val next = SessionGroupCollapsePrefs.decode(prefs[key(hubKey)]).toMutableMap()
            next[groupKey] = collapsed
            prefs[key(hubKey)] = SessionGroupCollapsePrefs.encode(next)
        }
    }

    private fun key(hubKey: String): Preferences.Key<String> = stringPreferencesKey("collapsed:$hubKey")
}

package app.hapi.companion.di

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import app.hapi.companion.feature.sessions.SessionDisplayPrefs
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

/**
 * [SessionDisplayPrefs] over the app-wide `hapi_prefs` DataStore. The
 * default (grouped) is stored as absence — same write-through convention as
 * the web display hooks, which remove the localStorage key when the value
 * equals the default. Unreadable prefs degrade to defaults (ThemePrefs
 * precedent).
 */
internal class DataStoreSessionDisplayPrefs(
    private val dataStore: DataStore<Preferences>,
) : SessionDisplayPrefs {

    override val grouped: Flow<Boolean> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> prefs[GROUPED] ?: SessionDisplayPrefs.DEFAULT_GROUPED }

    override suspend fun setGrouped(value: Boolean) {
        dataStore.edit { prefs ->
            if (value == SessionDisplayPrefs.DEFAULT_GROUPED) prefs.remove(GROUPED) else prefs[GROUPED] = value
        }
    }

    private companion object {
        val GROUPED = booleanPreferencesKey("session_list_grouped")
    }
}

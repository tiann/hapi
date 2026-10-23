package app.hapi.companion.feature.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Code-block word-wrap persistence over the app-wide `hapi_prefs` DataStore —
 * the web `useCodeWrap` / localStorage `hapi-code-wrap` twin. One app-wide
 * toggle shared by every code block (chat markdown, tool text, file viewer);
 * default off (web: absent key = no wrap). Unreadable prefs degrade to the
 * default (ThemePrefs precedent).
 */
class CodeWrapPrefs(private val dataStore: DataStore<Preferences>) {

    /** Current wrap choice; emits again on every change (same-tab broadcast twin). */
    val wrap: Flow<Boolean> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> prefs[WRAP_KEY] ?: false }
        .distinctUntilChanged()

    suspend fun setWrap(enabled: Boolean) {
        dataStore.edit { it[WRAP_KEY] = enabled }
    }

    companion object {
        val WRAP_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("code_wrap")
    }
}

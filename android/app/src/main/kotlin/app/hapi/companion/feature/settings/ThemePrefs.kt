package app.hapi.companion.feature.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Theme choice (web `ThemeMode` twin plus the Android-only Material You
 * switch). [OLED] is the pure-black variant — it implies dark and disables
 * dynamic color at the [app.hapi.companion.ui.theme.HapiTheme] call site.
 */
enum class ThemeMode(val storageKey: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    OLED("oled");

    companion object {
        /** Unknown/corrupt stored values degrade to [SYSTEM]. */
        fun fromStorageKey(raw: String?): ThemeMode =
            entries.firstOrNull { it.storageKey == raw } ?: SYSTEM
    }
}

/** The persisted appearance choice, defaults = follow system + Material You. */
data class ThemeSettings(
    val mode: ThemeMode = ThemeMode.SYSTEM,
    /** Material You wallpaper color (effective only on API 31+, non-OLED). */
    val dynamicColor: Boolean = true,
)

/**
 * Appearance persistence over the app-wide `hapi_prefs` DataStore. Read at
 * `MainActivity.setContent` to drive `HapiTheme`, written by the settings
 * screen; unreadable prefs degrade to defaults (roster storage precedent).
 */
class ThemePrefs(private val dataStore: DataStore<Preferences>) {

    /** Current settings; emits again on every change. */
    val settings: Flow<ThemeSettings> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs ->
            ThemeSettings(
                mode = ThemeMode.fromStorageKey(prefs[MODE_KEY]),
                dynamicColor = prefs[DYNAMIC_COLOR_KEY] ?: true,
            )
        }
        .distinctUntilChanged()

    suspend fun setMode(mode: ThemeMode) {
        dataStore.edit { it[MODE_KEY] = mode.storageKey }
    }

    suspend fun setDynamicColor(enabled: Boolean) {
        dataStore.edit { it[DYNAMIC_COLOR_KEY] = enabled }
    }

    companion object {
        val MODE_KEY: Preferences.Key<String> = stringPreferencesKey("theme_mode")
        val DYNAMIC_COLOR_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("theme_dynamic_color")
    }
}

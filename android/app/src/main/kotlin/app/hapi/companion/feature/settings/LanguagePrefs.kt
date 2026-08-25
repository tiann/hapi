package app.hapi.companion.feature.settings

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

/**
 * App language choice. [ENGLISH]/[SIMPLIFIED_CHINESE] mirror the web's
 * `Locale` (`'en' | 'zh-Hans'`); [SYSTEM] is the Android-only default —
 * follow the device language (empty per-app locale list).
 *
 * B-M5a wires the selection through `AppCompatDelegate.setApplicationLocales`
 * ([localeTags] is the BCP-47 tag list to apply); the Settings screen applies
 * it immediately on selection and appcompat's `autoStoreLocales` re-applies it
 * on cold start.
 */
enum class AppLanguage(val storageKey: String, val localeTags: String) {
    SYSTEM("system", ""),
    ENGLISH("en", "en"),
    SIMPLIFIED_CHINESE("zh-Hans", "zh-Hans");

    companion object {
        fun fromStorageKey(raw: String?): AppLanguage =
            entries.firstOrNull { it.storageKey == raw } ?: SYSTEM
    }
}

/** Language persistence over the app-wide `hapi_prefs` DataStore. */
class LanguagePrefs(private val dataStore: DataStore<Preferences>) {

    val language: Flow<AppLanguage> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> AppLanguage.fromStorageKey(prefs[LANGUAGE_KEY]) }
        .distinctUntilChanged()

    suspend fun setLanguage(language: AppLanguage) {
        dataStore.edit { it[LANGUAGE_KEY] = language.storageKey }
    }

    companion object {
        val LANGUAGE_KEY: Preferences.Key<String> = stringPreferencesKey("app_language")
    }
}

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

/**
 * Dictation provider + language persistence — the web twins are the
 * `hapi-transcription-provider` and `hapi-voice-lang` localStorage keys
 * (`useVoiceInputPreferences.ts`, `useVoiceSettings.ts`): a stored provider id
 * resolved against the hub's configured list (falling back to the first
 * standard-capable one), and a BCP-47 language code where absence means
 * auto-detect. App-wide rather than hub-scoped, like the other `hapi_prefs`
 * settings — a stale id on another hub self-heals through the fallback.
 */
interface DictationPrefs {
    /** Stored provider id, or null when the hub's preference order decides. */
    val providerId: Flow<String?>

    /** Stored BCP-47 language code, or null for auto-detect. */
    val language: Flow<String?>

    suspend fun setProviderId(providerId: String?)

    suspend fun setLanguage(code: String?)
}

/**
 * DataStore impl over the app-wide `hapi_prefs` store. Absent key = null =
 * auto/default (never written as an explicit value); an unreadable store
 * degrades to the same defaults — the contract of the roster prefs.
 */
class DataStoreDictationPrefs(
    private val dataStore: DataStore<Preferences>,
) : DictationPrefs {

    override val providerId: Flow<String?> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { it[PROVIDER_KEY] }
        .distinctUntilChanged()

    override val language: Flow<String?> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { it[LANGUAGE_KEY] }
        .distinctUntilChanged()

    override suspend fun setProviderId(providerId: String?) {
        dataStore.edit { prefs ->
            if (providerId == null) prefs.remove(PROVIDER_KEY) else prefs[PROVIDER_KEY] = providerId
        }
    }

    override suspend fun setLanguage(code: String?) {
        dataStore.edit { prefs ->
            if (code == null) prefs.remove(LANGUAGE_KEY) else prefs[LANGUAGE_KEY] = code
        }
    }

    companion object {
        private val PROVIDER_KEY = stringPreferencesKey("dictation_provider")
        private val LANGUAGE_KEY = stringPreferencesKey("dictation_language")
    }
}

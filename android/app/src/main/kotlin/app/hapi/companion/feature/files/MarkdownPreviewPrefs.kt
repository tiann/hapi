package app.hapi.companion.feature.files

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
 * Markdown preview/source choice over the app-wide `hapi_prefs` DataStore —
 * the Android twin of web localStorage `hapi.filePreview.markdownMode.v1`
 * (`file-markdown-preview.ts`): one global choice (not per session/file),
 * default Preview, and persisted as the non-default Source choice only —
 * picking Preview removes the key (web "normalize by absence"), so an absent
 * or unreadable key always reads as Preview (ThemePrefs degradation
 * precedent). Every write re-emits [source], the same-tab broadcast twin of
 * web `useCodeWrap`-style listeners.
 */
class MarkdownPreviewPrefs(private val dataStore: DataStore<Preferences>) {

    /** True when the user chose Source; emits again on every change. */
    val source: Flow<Boolean> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs -> prefs[SOURCE_KEY] ?: false }
        .distinctUntilChanged()

    suspend fun setSource(source: Boolean) {
        dataStore.edit { prefs ->
            if (source) prefs[SOURCE_KEY] = true else prefs.remove(SOURCE_KEY)
        }
    }

    companion object {
        val SOURCE_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("files_markdown_source")
    }
}

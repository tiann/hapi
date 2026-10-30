package app.hapi.companion.feature.directorybrowser

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import java.io.IOException
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first

/**
 * Directory-browser show-hidden persistence — the web twin is the
 * `hapi:workspaceBrowserShowHidden` localStorage key ('1'/'0', read at mount,
 * written on every toggle; `WorkspaceBrowser.tsx`). App-wide rather than
 * hub-scoped, like the other `hapi_prefs` settings (one user preference for
 * every browser surface).
 */
interface DirectoryBrowserPrefs {
    suspend fun readShowHidden(): Boolean
    suspend fun writeShowHidden(showHidden: Boolean)
}

/**
 * DataStore impl over the app-wide `hapi_prefs` store. Default false (hidden
 * entries excluded); an unreadable store degrades to the default — the same
 * contract as the roster/theme prefs.
 */
class DataStoreDirectoryBrowserPrefs(
    private val dataStore: DataStore<Preferences>,
) : DirectoryBrowserPrefs {

    override suspend fun readShowHidden(): Boolean =
        dataStore.data
            .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
            .first()[SHOW_HIDDEN_KEY] ?: false

    override suspend fun writeShowHidden(showHidden: Boolean) {
        dataStore.edit { it[SHOW_HIDDEN_KEY] = showHidden }
    }

    companion object {
        val SHOW_HIDDEN_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("directory_browser_show_hidden")
    }
}

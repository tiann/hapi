package app.hapi.companion.feature.files

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
 * Browse/search sort persistence over the app-wide `hapi_prefs` DataStore —
 * the Android twin of web localStorage key `hapi-directory-sort` (web
 * `files.tsx` writes on every change, reads with validation and falls back to
 * `DEFAULT_DIRECTORY_SORT` on corrupt values). App-wide, not per session,
 * matching the web.
 */
class DirectorySortPrefs(private val dataStore: DataStore<Preferences>) {

    /** Current sort; emits again on every change. */
    val sort: Flow<DirectorySort> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs ->
            DirectorySort(
                field = DirectorySortField.fromStorageKey(prefs[FIELD_KEY]) ?: DirectorySortField.NAME,
                direction = DirectorySortDirection.fromStorageKey(prefs[DIRECTION_KEY])
                    ?: DirectorySortDirection.ASC,
            )
        }
        .distinctUntilChanged()

    suspend fun setSort(sort: DirectorySort) {
        dataStore.edit {
            it[FIELD_KEY] = sort.field.storageKey
            it[DIRECTION_KEY] = sort.direction.storageKey
        }
    }

    companion object {
        val FIELD_KEY: Preferences.Key<String> = stringPreferencesKey("directory_sort_field")
        val DIRECTION_KEY: Preferences.Key<String> = stringPreferencesKey("directory_sort_direction")
    }
}

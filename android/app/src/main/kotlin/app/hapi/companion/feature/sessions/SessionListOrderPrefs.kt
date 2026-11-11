package app.hapi.companion.feature.sessions

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.protocol.wire.SessionListOrder
import app.hapi.protocol.wire.SessionListSort
import java.io.IOException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update

/**
 * Session-list ordering (sort key + Active first). Row-hiding filters stay
 * transient on the ViewModel; only ordering persists, like web's
 * `useSessionListView` localStorage keys.
 */
interface SessionListOrderStore {
    val order: Flow<SessionListOrder>
    suspend fun setSort(sort: SessionListSort)
    suspend fun setActiveFirst(enabled: Boolean)
}

/** Not persisted: tests, previews and surfaces that keep a fixed order (share picker passes the base order). */
class InMemorySessionListOrderStore(initial: SessionListOrder = SessionListOrder.Default) : SessionListOrderStore {
    private val state = MutableStateFlow(initial)
    override val order: Flow<SessionListOrder> = state
    override suspend fun setSort(sort: SessionListSort) = state.update { it.copy(sort = sort) }
    override suspend fun setActiveFirst(enabled: Boolean) = state.update { it.copy(activeFirst = enabled) }
}

/**
 * App-wide persistence over the `hapi_prefs` DataStore. Defaults are stored
 * as absent keys (web removes its keys too), so a changed default reaches
 * users who never chose; unreadable prefs degrade to defaults.
 */
class SessionListOrderPrefs(private val dataStore: DataStore<Preferences>) : SessionListOrderStore {

    override val order: Flow<SessionListOrder> = dataStore.data
        .catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }
        .map { prefs ->
            SessionListOrder(
                sort = SessionListSort.fromStorageKey(prefs[SORT_KEY]),
                activeFirst = prefs[ACTIVE_FIRST_KEY] ?: SessionListOrder.Default.activeFirst,
            )
        }
        .distinctUntilChanged()

    override suspend fun setSort(sort: SessionListSort) {
        dataStore.edit {
            if (sort == SessionListOrder.Default.sort) it.remove(SORT_KEY) else it[SORT_KEY] = sort.storageKey
        }
    }

    override suspend fun setActiveFirst(enabled: Boolean) {
        dataStore.edit {
            if (enabled == SessionListOrder.Default.activeFirst) it.remove(ACTIVE_FIRST_KEY) else it[ACTIVE_FIRST_KEY] = enabled
        }
    }

    companion object {
        val SORT_KEY: Preferences.Key<String> = stringPreferencesKey("session_list_sort")
        val ACTIVE_FIRST_KEY: Preferences.Key<Boolean> = booleanPreferencesKey("session_list_active_first")
    }
}

package app.hapi.companion.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.hapi.companion.feature.chat.composer.ChatDrafts
import kotlinx.coroutines.flow.first

/**
 * Process-wide drafts DataStore. Separate from `hapi_prefs` so bursty
 * draft writes never contend with the hub roster file.
 */
internal val Context.chatDraftsDataStore: DataStore<Preferences> by preferencesDataStore(name = "chat_drafts")

/**
 * [ChatDrafts] over a Preferences DataStore, keys scoped `draft:<hub>:<id>`
 * so multiple paired hubs never collide on a session id.
 */
class DataStoreChatDrafts(
    private val dataStore: DataStore<Preferences>,
    private val hubKey: String,
) : ChatDrafts {

    private fun key(sessionId: String): Preferences.Key<String> =
        stringPreferencesKey("draft:$hubKey:$sessionId")

    override suspend fun load(sessionId: String): String? =
        dataStore.data.first()[key(sessionId)]?.takeIf { it.isNotEmpty() }

    override suspend fun save(sessionId: String, text: String) {
        dataStore.edit { prefs ->
            if (text.isBlank()) prefs.remove(key(sessionId)) else prefs[key(sessionId)] = text
        }
    }

    override suspend fun clear(sessionId: String) {
        dataStore.edit { prefs -> prefs.remove(key(sessionId)) }
    }

    override suspend fun move(fromSessionId: String, toSessionId: String) {
        if (fromSessionId == toSessionId) return
        dataStore.edit { prefs ->
            val draft = prefs[key(fromSessionId)] ?: return@edit
            prefs.remove(key(fromSessionId))
            // Never clobber a draft already typed in the target session.
            if (prefs[key(toSessionId)].isNullOrEmpty()) prefs[key(toSessionId)] = draft
        }
    }
}

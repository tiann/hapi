package app.hapi.companion.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.chat.composer.appendSharedText
import app.hapi.companion.feature.share.ShareInbox
import app.hapi.companion.feature.chat.composer.DraftRing
import app.hapi.protocol.wire.HapiJson
import kotlinx.coroutines.flow.first
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Process-wide drafts DataStore. Separate from `hapi_prefs` so bursty
 * draft writes never contend with the hub roster file.
 */
internal val Context.chatDraftsDataStore: DataStore<Preferences> by preferencesDataStore(name = "chat_drafts")

/**
 * [ChatDrafts] over a Preferences DataStore, keys scoped `draft:<hub>:<id>`
 * so multiple paired hubs never collide on a session id.
 *
 * Drafts v2 adds the web's `MAX_DRAFTS = 50` cap: a shadow index
 * `draft-index:<hub>` tracks last-touched timestamps and
 * [DraftRing.touch] evicts the least-recently-touched session's row on
 * write. A lost/corrupt index re-adopts orphan rows by prefix scan (the
 * cap must bound the store even after index loss); a corrupt index decodes
 * to empty, silently — the `NewSessionPrefs` precedent.
 */
class DataStoreChatDrafts(
    private val dataStore: DataStore<Preferences>,
    private val hubKey: String,
    /** Injectable for deterministic ring tests. */
    private val now: () -> Long = System::currentTimeMillis,
) : ChatDrafts {

    private fun key(sessionId: String): Preferences.Key<String> =
        stringPreferencesKey("draft:$hubKey:$sessionId")

    private val indexKey: Preferences.Key<String> =
        stringPreferencesKey("draft-index:$hubKey")

    /** Value-key prefix for this hub (the index key itself never matches it). */
    private val keyPrefix: String = "draft:$hubKey:"

    override suspend fun load(sessionId: String): String? =
        dataStore.data.first()[key(sessionId)]?.takeIf { it.isNotEmpty() }

    override suspend fun save(sessionId: String, text: String) {
        dataStore.edit { prefs ->
            if (text.isBlank()) {
                prefs.remove(key(sessionId))
                removeFromIndex(prefs, sessionId)
            } else {
                prefs[key(sessionId)] = text
                touchAndPrune(prefs, sessionId)
            }
        }
    }

    override suspend fun clear(sessionId: String) {
        dataStore.edit { prefs ->
            prefs.remove(key(sessionId))
            removeFromIndex(prefs, sessionId)
        }
    }

    override suspend fun move(fromSessionId: String, toSessionId: String) {
        if (fromSessionId == toSessionId) return
        dataStore.edit { prefs ->
            val draft = prefs[key(fromSessionId)] ?: run {
                removeFromIndex(prefs, fromSessionId)
                return@edit
            }
            prefs.remove(key(fromSessionId))
            removeFromIndex(prefs, fromSessionId)
            // Never clobber a draft already typed in the target session.
            if (prefs[key(toSessionId)].isNullOrEmpty()) {
                prefs[key(toSessionId)] = draft
                touchAndPrune(prefs, toSessionId)
                val prefix = "draftShare:$hubKey:$fromSessionId:"
                prefs.asMap().filter { it.key.name.startsWith(prefix) }.forEach { (receipt, timestamp) ->
                    prefs[longPreferencesKey("draftShare:$hubKey:$toSessionId:${receipt.name.removePrefix(prefix)}")] = timestamp as Long
                    prefs.remove(receipt)
                }
            }
        }
    }

    /**
     * Read the ring index, adopting value rows the index does not know (a
     * lost/corrupt index must not leave orphan rows outside the ring —
     * otherwise the cap cannot bound the store).
     */
    private fun readIndex(prefs: Preferences): LinkedHashMap<String, Long> {
        val index = decodeIndex(prefs[indexKey])
        val known = index.keys
        val adopted = prefs.asMap().keys
            .filterIsInstance<Preferences.Key<String>>()
            .filter { it.name.startsWith(keyPrefix) }
            .map { it.name.removePrefix(keyPrefix) }
            .filter { it.isNotEmpty() && it !in known }
        adopted.forEach { index[it] = now() }
        return index
    }

    private fun removeFromIndex(prefs: MutablePreferences, sessionId: String) {
        val index = readIndex(prefs)
        if (index.remove(sessionId) != null) prefs[indexKey] = encodeIndex(index)
    }

    private fun touchAndPrune(prefs: MutablePreferences, sessionId: String) {
        val index = readIndex(prefs)
        val evicted = DraftRing.touch(index, sessionId, now())
        prefs[indexKey] = encodeIndex(index)
        evicted.forEach { evictedId ->
            if (evictedId != sessionId) prefs.remove(key(evictedId))
        }
    }

    companion object {
        internal fun encodeIndex(index: Map<String, Long>): String =
            HapiJson.encodeToString(MapSerializer(String.serializer(), Long.serializer()), index)

        internal fun decodeIndex(raw: String?): LinkedHashMap<String, Long> {
            if (raw.isNullOrEmpty()) return LinkedHashMap()
            return runCatching {
                HapiJson.decodeFromString(MapSerializer(String.serializer(), Long.serializer()), raw)
            }.getOrNull()?.let { LinkedHashMap(it) } ?: LinkedHashMap()
        }
    }

    override suspend fun appendSharedText(sessionId: String, requestId: String, currentText: String, text: String): String {
        var result = currentText
        dataStore.edit { prefs ->
            val now = System.currentTimeMillis()
            prefs.asMap().filter {
                it.key.name.startsWith("draftShare:$hubKey:") && (it.value as? Long ?: Long.MAX_VALUE) < now - ShareInbox.RETENTION_MS
            }.keys.forEach { prefs.remove(it) }
            val receipt = longPreferencesKey("draftShare:$hubKey:$sessionId:$requestId")
            if (prefs[receipt] == null) {
                result = appendSharedText(currentText, text)
                prefs[key(sessionId)] = result
                prefs[receipt] = now
            }
        }
        return result
    }
}

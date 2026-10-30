package app.hapi.companion.di

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment
import app.hapi.companion.feature.chat.composer.AttachmentDrafts
import app.hapi.companion.feature.chat.composer.DraftRing
import app.hapi.protocol.wire.HapiJson
import kotlinx.coroutines.flow.first
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/**
 * [AttachmentDrafts] over the process-wide drafts DataStore (see
 * [chatDraftsDataStore] — separate from `hapi_prefs` so bursty tray writes
 * never contend with the roster file). Rows are JSON reference lists under
 * `adraft:<hub>:<id>`; a shadow index `adraft-index:<hub>` tracks
 * last-touched timestamps and feeds the max-50 recency ring
 * ([DraftRing] evicts the least-recently-touched session's row).
 *
 * Corruption is silent-degrading, the `NewSessionPrefs` precedent: a value
 * that fails to decode (or decodes path-less entries) yields an empty list,
 * a corrupt index yields an empty index whose orphan rows are re-adopted by
 * the next write's prefix scan — either way the store falls back to "no
 * draft", never to a crash.
 */
class DataStoreAttachmentDrafts(
    private val dataStore: DataStore<Preferences>,
    private val hubKey: String,
    /** Injectable for deterministic ring tests. */
    private val now: () -> Long = System::currentTimeMillis,
) : AttachmentDrafts {

    private fun key(sessionId: String): Preferences.Key<String> =
        stringPreferencesKey("adraft:$hubKey:$sessionId")

    private val indexKey: Preferences.Key<String> =
        stringPreferencesKey("adraft-index:$hubKey")

    /** Value-key prefix for this hub (the index key itself never matches it). */
    private val keyPrefix: String = "adraft:$hubKey:"

    override suspend fun load(sessionId: String): List<ComposerDraftAttachment> =
        decodeAttachments(dataStore.data.first()[key(sessionId)])

    override suspend fun save(sessionId: String, attachments: List<ComposerDraftAttachment>) {
        dataStore.edit { prefs ->
            if (attachments.isEmpty()) {
                prefs.remove(key(sessionId))
                removeFromIndex(prefs, sessionId)
            } else {
                prefs[key(sessionId)] = encodeAttachments(attachments)
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
            val raw = prefs[key(fromSessionId)] ?: run {
                removeFromIndex(prefs, fromSessionId)
                return@edit
            }
            // Source first (single transaction — no window where both or
            // neither row exists), then the target only when it has no
            // draft of its own, matching [DataStoreChatDrafts.move].
            prefs.remove(key(fromSessionId))
            removeFromIndex(prefs, fromSessionId)
            if (prefs[key(toSessionId)].isNullOrEmpty()) {
                prefs[key(toSessionId)] = raw
                touchAndPrune(prefs, toSessionId)
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
        internal fun encodeAttachments(attachments: List<ComposerDraftAttachment>): String =
            HapiJson.encodeToString(ListSerializer(ComposerDraftAttachment.serializer()), attachments)

        /** Decode-defensive: corrupt JSON or path-less entries degrade to empty. */
        internal fun decodeAttachments(raw: String?): List<ComposerDraftAttachment> {
            if (raw.isNullOrEmpty()) return emptyList()
            val decoded = runCatching {
                HapiJson.decodeFromString(ListSerializer(ComposerDraftAttachment.serializer()), raw)
            }.getOrNull() ?: return emptyList()
            return decoded.filter { it.path != null && it.id.isNotEmpty() }
        }

        internal fun encodeIndex(index: Map<String, Long>): String =
            HapiJson.encodeToString(MapSerializer(String.serializer(), Long.serializer()), index)

        internal fun decodeIndex(raw: String?): LinkedHashMap<String, Long> {
            if (raw.isNullOrEmpty()) return LinkedHashMap()
            return runCatching {
                HapiJson.decodeFromString(MapSerializer(String.serializer(), Long.serializer()), raw)
            }.getOrNull()?.let { LinkedHashMap(it) } ?: LinkedHashMap()
        }
    }
}

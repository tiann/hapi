package app.hapi.companion.feature.sessions

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * Per-directory-group collapse overrides for the grouped session list (web
 * `SessionList.tsx` `collapseOverrides`). Web keeps a plain in-memory `Map`
 * that dies on every reload; Android processes get killed constantly, so the
 * overrides persist (DataStore twin below — the same divergence the
 * files `DirectoryExpandPrefs` header documents).
 */
interface SessionGroupCollapsePrefs {

    /** Collapse overrides for one hub: group key (`machineId::directory`) → collapsed. */
    fun overrides(hubKey: String): Flow<Map<String, Boolean>>

    /** Record one group's collapse choice (persisted; survives process death). */
    suspend fun setOverride(hubKey: String, groupKey: String, collapsed: Boolean)

    companion object {
        fun encode(overrides: Map<String, Boolean>): String =
            JsonObject(overrides.mapValues { (_, collapsed) -> JsonPrimitive(collapsed) }).toString()

        /** Non-object or non-boolean payloads degrade to the empty map (web reads nothing back). */
        fun decode(raw: String?): Map<String, Boolean> {
            if (raw == null) return emptyMap()
            val element = try {
                Json.parseToJsonElement(raw)
            } catch (_: Exception) {
                return emptyMap()
            }
            if (element !is JsonObject) return emptyMap()
            return element.entries.mapNotNull { (key, value) ->
                (value as? JsonPrimitive)?.booleanOrNull?.let { key to it }
            }.toMap()
        }
    }
}

/** In-memory implementation for tests and previews. */
class InMemorySessionGroupCollapsePrefs : SessionGroupCollapsePrefs {
    private val state = MutableStateFlow<Map<String, Boolean>>(emptyMap())

    override fun overrides(hubKey: String): Flow<Map<String, Boolean>> =
        state.map { it }

    override suspend fun setOverride(hubKey: String, groupKey: String, collapsed: Boolean) {
        state.value = state.value + (groupKey to collapsed)
    }
}

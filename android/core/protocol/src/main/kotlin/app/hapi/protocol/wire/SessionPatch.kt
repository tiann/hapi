package app.hapi.protocol.wire

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * Atomic `{version, value}` pair used by structured `session-updated` patches
 * for `metadata` / `agentState` / `todos` / `teamState`. The version is the
 * only safe way to reject stale patches — the dual SSE connections have no
 * shared ordering. Never assign the wrapper itself into a [Session]; apply
 * `value` and store `version` (see `docs/api/client-contract/sse.md`).
 */
data class VersionedValue<T>(
    /**
     * Write counter (metadata/agentState) or epoch-ms watermark
     * (todos/teamState) — compared strictly-greater against the cached
     * watermark on [Session].
     */
    val version: Long,
    val value: T?,
)

/**
 * Decoded `SessionPatch` (`SessionPatchSchema`, `shared/src/schemas.ts`
 * — strict). Build via [SessionPatches.parse]; a data-class instance is also
 * fine for tests/local use.
 *
 * Field encoding of zod optionality:
 * - optional non-nullable fields → plain `T?` where `null` means absent;
 * - `nullable().optional()` fields ([activeTurnStartedAt], [model],
 *   [modelReasoningEffort], [effort], [serviceTier]) → [OptionalField], because
 *   an explicit wire `null` clears the target field while absence leaves it
 *   untouched.
 *
 * Note `activeTurnStartedAt` and `scratchlistUpdatedAt` are carried but never
 * assigned by `applySessionDetailPatch` — replicating the reference client
 * (see `app.hapi.protocol.patch.SessionPatching`).
 */
data class SessionPatch(
    val active: Boolean? = null,
    val thinking: Boolean? = null,
    val activeTurnStartedAt: OptionalField<Long?> = OptionalField.Absent,
    val activeAt: Long? = null,
    val updatedAt: Long? = null,
    val metadata: VersionedValue<SessionMetadata>? = null,
    val agentState: VersionedValue<AgentState>? = null,
    val todos: VersionedValue<List<TodoItem>>? = null,
    val teamState: VersionedValue<JsonElement>? = null,
    val model: OptionalField<String?> = OptionalField.Absent,
    val modelReasoningEffort: OptionalField<String?> = OptionalField.Absent,
    val effort: OptionalField<String?> = OptionalField.Absent,
    val serviceTier: OptionalField<String?> = OptionalField.Absent,
    val permissionMode: String? = null,
    val collaborationMode: String? = null,
    val copilotAgentMode: String? = null,
    val backgroundTaskCount: Int? = null,
    /** Bare refetch trigger for `GET /sessions/:id/scratchlist`; carries no data. */
    val scratchlistUpdatedAt: Long? = null,
)

object SessionPatches {
    private val KNOWN_KEYS = setOf(
        "active", "thinking", "activeTurnStartedAt", "activeAt", "updatedAt",
        "metadata", "agentState", "todos", "teamState",
        "model", "modelReasoningEffort", "effort", "serviceTier",
        "permissionMode", "collaborationMode", "copilotAgentMode",
        "backgroundTaskCount", "scratchlistUpdatedAt",
    )

    /**
     * Parse a `session-updated` data payload as a [SessionPatch], mirroring
     * the web reference `getSessionPatch` (`SessionPatchSchema.safeParse` +
     * non-empty check): returns `null` for anything that is not a valid,
     * non-empty patch — the caller then treats the payload as a full
     * [Session] or falls back to a REST refetch.
     *
     * Strictness is load-bearing: `SessionPatchSchema` is `.strict()`, so an
     * unknown key (e.g. `id` on a full session object) must fail. Total —
     * never throws.
     *
     * Deliberate leniencies vs zod (noted, not accidental): enum-typed
     * strings (`permissionMode` etc.) accept any string so a future hub mode
     * cannot force a refetch loop, and `teamState.value` is only shallowly
     * checked (object with string `teamName`, or null).
     */
    fun parse(element: JsonElement?): SessionPatch? {
        val obj = element as? JsonObject ?: return null
        if (obj.isEmpty() || obj.keys.any { it !in KNOWN_KEYS }) return null
        return try {
            SessionPatch(
                active = obj["active"]?.let { it.boolOrNull ?: return null },
                thinking = obj["thinking"]?.let { it.boolOrNull ?: return null },
                activeTurnStartedAt = optionalNullableLong(obj, "activeTurnStartedAt") ?: return null,
                activeAt = obj["activeAt"]?.let { it.longOrNull ?: return null },
                updatedAt = obj["updatedAt"]?.let { it.longOrNull ?: return null },
                metadata = obj["metadata"]?.let { wrapper ->
                    versioned(wrapper) { value ->
                        if (value is JsonNull) null
                        else HapiJson.decodeFromJsonElement(SessionMetadata.serializer(), value)
                    } ?: return null
                },
                agentState = obj["agentState"]?.let { wrapper ->
                    versioned(wrapper) { value ->
                        if (value is JsonNull) null
                        else HapiJson.decodeFromJsonElement(AgentState.serializer(), value)
                    } ?: return null
                },
                todos = obj["todos"]?.let { wrapper ->
                    versioned(wrapper) { value ->
                        if (value !is JsonArray) throw IllegalArgumentException("todos.value must be an array")
                        value.map { HapiJson.decodeFromJsonElement(TodoItem.serializer(), it) }
                    } ?: return null
                },
                teamState = obj["teamState"]?.let { wrapper ->
                    versioned(wrapper) { value ->
                        when {
                            value is JsonNull -> null // TeamDelete clear
                            value is JsonObject && value["teamName"].stringOrNull != null -> value
                            else -> throw IllegalArgumentException("teamState.value must be null or a team object")
                        }
                    } ?: return null
                },
                model = optionalNullableString(obj, "model") ?: return null,
                modelReasoningEffort = optionalNullableString(obj, "modelReasoningEffort") ?: return null,
                effort = optionalNullableString(obj, "effort") ?: return null,
                serviceTier = optionalNullableString(obj, "serviceTier") ?: return null,
                permissionMode = obj["permissionMode"]?.let { it.stringOrNull ?: return null },
                collaborationMode = obj["collaborationMode"]?.let { it.stringOrNull ?: return null },
                copilotAgentMode = obj["copilotAgentMode"]?.let { raw ->
                    val mode = raw.stringOrNull ?: return null
                    // zod coerces the legacy `'fleet'` literal to 'interactive'.
                    if (mode == "fleet") "interactive" else mode
                },
                backgroundTaskCount = obj["backgroundTaskCount"]?.let { it.intOrNull ?: return null },
                scratchlistUpdatedAt = obj["scratchlistUpdatedAt"]?.let { it.longOrNull ?: return null },
            )
        } catch (_: Exception) {
            null
        }
    }

    /** `{version, value}` wrapper: `version` must be a number, `value` key must exist. */
    private fun <T> versioned(wrapper: JsonElement, decodeValue: (JsonElement) -> T?): VersionedValue<T>? {
        val obj = wrapper as? JsonObject ?: return null
        val version = obj["version"].longOrNull ?: return null
        if (!obj.containsKey("value")) return null
        return try {
            VersionedValue(version, decodeValue(obj.getValue("value")))
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Tri-state for `z.number().nullable().optional()`: absent → Absent,
     * `null` → Present(null), number → Present(n); anything else → null (invalid).
     */
    private fun optionalNullableLong(obj: JsonObject, key: String): OptionalField<Long?>? {
        val raw = obj[key] ?: return OptionalField.Absent
        if (raw is JsonNull) return OptionalField.Present(null)
        return raw.longOrNull?.let { OptionalField.Present(it) }
    }

    /** Tri-state for `z.string().nullable().optional()`. */
    private fun optionalNullableString(obj: JsonObject, key: String): OptionalField<String?>? {
        val raw = obj[key] ?: return OptionalField.Absent
        if (raw is JsonNull) return OptionalField.Present(null)
        return raw.stringOrNull?.let { OptionalField.Present(it) }
    }
}

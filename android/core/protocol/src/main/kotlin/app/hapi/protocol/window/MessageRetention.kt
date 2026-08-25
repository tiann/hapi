package app.hapi.protocol.window

import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Renderability predicate for window retention — a faithful port of the
 * **null-decision tree** of `normalizeDecryptedMessage`
 * (`web/src/chat/normalize.ts` + `web/src/chat/normalizeAgent.ts` +
 * `shared/src/messages.ts`), used by the web store's
 * `shouldRetainWindowMessage`: rows the chat pipeline would hide never enter
 * the window (but still advance cursors).
 *
 * The web returns `null` (⇒ hidden) in exactly two situations:
 *  1. agent rows whose content `isSkippableAgentContent` (meta/compact-summary
 *     Claude output, empty recaps/agy steps, non-chat-visible system rows);
 *  2. codex-envelope agent rows (`content.type === 'codex'`) whose payload
 *     the codex switch of `normalizeAgentRecord` cannot render.
 * Everything else — user rows, unknown roles, unparseable envelopes — falls
 * back to a raw-stringify bubble and is renderable.
 *
 * TODO(B-M2a dedup): the full chat-pipeline port owns the complete
 * `normalizeAgentRecord`; once it lands, this predicate should be re-expressed
 * as `normalize(...) != null` so the two cannot drift.
 */
object MessageRetention {

    fun isRenderable(content: JsonElement): Boolean {
        val record = unwrapRoleWrappedRecordEnvelope(content) ?: return true
        if (record.role != "agent") return true
        if (isSkippableAgentContent(record.content)) return false
        if (isCodexContent(record.content) && !isRenderableCodexContent(record.content)) return false
        return true
    }

    // ------------------------------------------------------------ envelope --

    internal data class RoleWrappedRecord(val role: String, val content: JsonElement)

    /** `shared/src/messages.ts` `isRoleWrappedRecord`: object with a string `role` and a `content` key. */
    private fun asRoleWrappedRecord(value: JsonElement?): RoleWrappedRecord? {
        val obj = value as? JsonObject ?: return null
        val role = obj["role"].stringOrNull ?: return null
        if (!obj.containsKey("content")) return null
        return RoleWrappedRecord(role, obj["content"] ?: JsonNull)
    }

    /** `shared/src/messages.ts` `unwrapRoleWrappedRecordEnvelope`. */
    internal fun unwrapRoleWrappedRecordEnvelope(value: JsonElement?): RoleWrappedRecord? {
        asRoleWrappedRecord(value)?.let { return it }
        val obj = value as? JsonObject ?: return null
        asRoleWrappedRecord(obj["message"])?.let { return it }
        (obj["data"] as? JsonObject)?.let { data -> asRoleWrappedRecord(data["message"])?.let { return it } }
        (obj["payload"] as? JsonObject)?.let { payload -> asRoleWrappedRecord(payload["message"])?.let { return it } }
        return null
    }

    // ------------------------------------------------- JS-semantics helpers --

    /** JS `isObject` (`shared/src/utils.ts`): non-null `typeof 'object'` — arrays included. */
    private fun jsIsObject(value: JsonElement?): Boolean =
        value is JsonObject || value is JsonArray

    /** JS property access: arrays and primitives have no string keys (→ undefined). */
    private fun prop(value: JsonElement?, key: String): JsonElement? =
        (value as? JsonObject)?.get(key)

    /** JS `asString`: the value iff it is a string. */
    private fun asString(value: JsonElement?): String? = value.stringOrNull

    /** JS `asNumber`: the value iff it is a finite number. */
    private fun asNumber(value: JsonElement?): Double? =
        (value as? JsonPrimitive)?.takeUnless { it.isString }?.content?.toDoubleOrNull()
            ?.takeIf { it.isFinite() }

    /** JS `Boolean(x)` truthiness over a JSON value. */
    private fun jsTruthy(value: JsonElement?): Boolean = when (value) {
        null, is JsonNull -> false
        is JsonObject, is JsonArray -> true
        is JsonPrimitive -> when {
            value.isString -> value.content.isNotEmpty()
            value.content == "true" -> true
            value.content == "false" -> false
            else -> value.content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: false
        }
    }

    /** JS `a ?? b` over JSON lookups (absent and `null` fall through). */
    private fun coalesce(vararg values: JsonElement?): JsonElement? =
        values.firstOrNull { it != null && it !is JsonNull }

    // --------------------------------------------------- agent skippability --

    private val VISIBLE_CLAUDE_SYSTEM_SUBTYPES = setOf(
        "api_error",
        "turn_duration",
        "microcompact_boundary",
        "compact_boundary",
        "away_summary",
    )

    /** `shared/src/messages.ts` `isClaudeChatVisibleMessage`. */
    private fun isClaudeChatVisibleMessage(type: JsonElement?, subtype: JsonElement?): Boolean {
        val typeString = type.stringOrNull
        if (typeString == "rate_limit_event") return false
        if (typeString == "tool_progress") return false
        if (typeString != "system") return true
        return subtype.stringOrNull in VISIBLE_CLAUDE_SYSTEM_SUBTYPES
    }

    /** `web/src/chat/normalizeAgent.ts` `isSkippableAgentContent`. */
    internal fun isSkippableAgentContent(content: JsonElement?): Boolean {
        if (prop(content, "type").stringOrNull != "output") return false
        val data = prop(content, "data")?.takeIf { jsIsObject(it) } ?: return false
        if (jsTruthy(prop(data, "isMeta")) || jsTruthy(prop(data, "isCompactSummary"))) return true
        val dataType = prop(data, "type")
        val subtype = prop(data, "subtype")
        if (
            dataType.stringOrNull == "system"
            && subtype.stringOrNull == "away_summary"
            && asString(prop(data, "content"))?.trim().isNullOrEmpty()
        ) {
            return true
        }
        if (
            dataType.stringOrNull == "agy_message"
            && (asString(prop(data, "content")) ?: "").trim().isEmpty()
        ) {
            return true
        }
        return !isClaudeChatVisibleMessage(dataType, subtype)
    }

    /** `content.type === AGENT_MESSAGE_PAYLOAD_TYPE` (`'codex'`, `shared/src/modes.ts`). */
    internal fun isCodexContent(content: JsonElement?): Boolean =
        prop(content, "type").stringOrNull == "codex"

    // ------------------------------------------------- codex renderability --

    /**
     * Whether the codex branch of `normalizeAgentRecord` yields a non-null
     * message for this content (`web/src/chat/normalizeAgent.ts:923-1241`).
     */
    internal fun isRenderableCodexContent(content: JsonElement?): Boolean {
        val data = prop(content, "data")?.takeIf { jsIsObject(it) } ?: return false
        val type = prop(data, "type").stringOrNull ?: return false
        return when (type) {
            "agent-run-start", "agent-run-update", "agent-run-trace" -> true
            "generated-image" ->
                !asString(coalesce(prop(data, "imageId"), prop(data, "image_id"))).isNullOrEmpty()
            "error" -> prop(data, "message").stringOrNull != null
            "message" -> prop(data, "message").stringOrNull != null
            "reasoning" -> prop(data, "message").stringOrNull != null
            "context_compacted" -> true
            "compact-summary" -> prop(data, "summary").stringOrNull != null
            "token_count" -> hasCodexTokenUsage(data)
            "thread_goal_updated" -> hasValidThreadGoal(prop(data, "goal"))
            "thread_goal_cleared" -> true
            "tool-call" -> prop(data, "callId").stringOrNull != null
            "tool-call-result" -> prop(data, "callId").stringOrNull != null
            "plan" -> hasPlanEntries(coalesce(prop(data, "entries"), prop(data, "items")) ?: data)
            "plan_update" -> hasPlanEntries(
                coalesce(prop(data, "plan"), prop(data, "update"), prop(data, "items"), prop(data, "steps")) ?: data
            )
            else -> false
        }
    }

    /** Null-condition of `normalizeCodexTokenUsage`: `info` object with numeric input+output tokens. */
    private fun hasCodexTokenUsage(data: JsonElement): Boolean {
        val info = prop(data, "info")?.takeIf { jsIsObject(it) } ?: return false
        val usageSource = sequenceOf("last", "lastTokenUsage", "last_token_usage", "total", "totalTokenUsage", "total_token_usage")
            .map { prop(info, it) }
            .firstOrNull { jsIsObject(it) }
            ?: info
        val input = asNumber(coalesce(prop(usageSource, "inputTokens"), prop(usageSource, "input_tokens")))
        val output = asNumber(coalesce(prop(usageSource, "outputTokens"), prop(usageSource, "output_tokens")))
        return input != null && output != null
    }

    /** Null-condition of `normalizeThreadGoal`. */
    private fun hasValidThreadGoal(goal: JsonElement?): Boolean {
        if (!jsIsObject(goal)) return false
        val threadId = asString(coalesce(prop(goal, "threadId"), prop(goal, "thread_id")))
        val objective = asString(prop(goal, "objective"))
        val status = asString(prop(goal, "status"))
        if (threadId.isNullOrEmpty() || objective.isNullOrEmpty() || status.isNullOrEmpty()) return false
        return status in setOf("active", "paused", "budgetLimited", "usageLimited", "blocked", "complete")
    }

    /** Non-empty condition of `normalizePlanEntries`. */
    private fun hasPlanEntries(value: JsonElement?): Boolean {
        val entries: List<JsonElement> = when {
            value is JsonArray -> value
            jsIsObject(value) -> sequenceOf("plan", "items", "steps")
                .map { prop(value, it) }
                .firstOrNull { it is JsonArray }
                ?.let { (it as JsonArray).toList() }
                ?: emptyList()
            else -> emptyList()
        }
        return entries.any { entry ->
            entry.stringOrNull != null || (
                entry is JsonObject && sequenceOf("step", "content", "text", "title", "description")
                    .any { key -> !asString(prop(entry, key)).isNullOrEmpty() }
                )
        }
    }
}

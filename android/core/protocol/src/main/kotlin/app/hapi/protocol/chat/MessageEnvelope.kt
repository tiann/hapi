package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Envelope helpers ported from `shared/src/messages.ts` (the subset the chat
 * pipeline consumes). `DecryptedMessage.content` is a role-wrapped envelope;
 * see `docs/api/client-contract/messages.md` ("Envelope").
 */

/** `{ role, content, meta? }` — the unwrapped record. [meta] is verbatim wire. */
data class RoleWrappedRecord(
    val role: String,
    /** Present by contract (`'content' in value`); JSON null stays [kotlinx.serialization.json.JsonNull]. */
    val content: JsonElement,
    val meta: JsonElement?,
)

private fun asRoleWrappedRecord(value: JsonElement?): RoleWrappedRecord? {
    val record = asObject(value) ?: return null
    val role = asString(record["role"]) ?: return null
    if (!record.containsKey("content")) return null
    return RoleWrappedRecord(role = role, content = record.getValue("content"), meta = record["meta"])
}

/**
 * `unwrapRoleWrappedRecordEnvelope`: the value itself, or probe
 * `value.message`, `value.data.message`, `value.payload.message` in order.
 */
fun unwrapRoleWrappedRecordEnvelope(value: JsonElement?): RoleWrappedRecord? {
    asRoleWrappedRecord(value)?.let { return it }
    val record = asObject(value) ?: return null

    asRoleWrappedRecord(record["message"])?.let { return it }
    asRoleWrappedRecord(asObject(record["data"])?.get("message"))?.let { return it }
    asRoleWrappedRecord(asObject(record["payload"])?.get("message"))?.let { return it }
    return null
}

private val VISIBLE_CLAUDE_SYSTEM_SUBTYPES = setOf(
    "api_error",
    "turn_duration",
    "microcompact_boundary",
    "compact_boundary",
    "away_summary",
)

fun isClaudeChatVisibleSystemSubtype(subtype: JsonElement?): Boolean =
    asString(subtype) in VISIBLE_CLAUDE_SYSTEM_SUBTYPES

/** `isClaudeChatVisibleMessage` over the raw `data` record's type/subtype. */
fun isClaudeChatVisibleMessage(type: JsonElement?, subtype: JsonElement?): Boolean {
    val typeString = asString(type)
    if (typeString == "rate_limit_event") return false
    if (typeString == "tool_progress") return false
    if (typeString != "system") return true
    return isClaudeChatVisibleSystemSubtype(subtype)
}

private val GOAL_STATUS_REGEX =
    Regex("^Goal (active|paused|complete|blocked|limited by (?:budget|usage))(?:$|\\s+·\\s+)")

/** `isRedundantGoalStatusMessageText` — hub-side goal status echoes. */
fun isRedundantGoalStatusMessageText(value: String?): Boolean {
    if (value == null) return false
    val message = value.trim()
    return message == "Goal cleared" || GOAL_STATUS_REGEX.containsMatchIn(message)
}

/** JSON-object contract shared by decrypted content: an object with a string `type`. */
internal fun typedRecordOrNull(value: JsonElement?): Pair<JsonObject, String>? {
    val record = asObject(value) ?: return null
    val type = asString(record["type"]) ?: return null
    return record to type
}

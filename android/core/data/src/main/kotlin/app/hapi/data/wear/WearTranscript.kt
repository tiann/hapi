package app.hapi.data.wear

import app.hapi.protocol.wire.DecryptedMessage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One transcript row the watch can render: a role plus plain text. */
data class WearTranscriptLine(val role: String, val text: String, val createdAt: Long)

/**
 * Projects a hub transcript down to what a watch screen can show: plain
 * conversational text, newest-last, with tool-call / tool-result / event
 * noise dropped. `DecryptedMessage.content` is a tagged union that varies by
 * agent flavor (`docs/api/client-contract/index.md`):
 *
 * - User input (all flavors): `content.content = {type: "text", text: "..."}`
 * - Claude (ACP-style): `content.content = {type: "output", data: {type:
 *   "message", message: {role, content: [{type: "text", text}, ...]}}}`
 * - Codex / Gemini events: `content.content = {type: "codex"|"event", data:
 *   {type: "message", message: "plain string", id}}`
 * - Tool calls / token counts / ready events: structurally similar, no
 *   user-visible text — dropped.
 *
 * A watch is for scanning a conversation, not debugging tool plumbing; the
 * PWA remains the full-fidelity surface.
 */
object WearTranscript {

    private val NON_TEXT_EVENT_TYPES = setOf(
        "tool-call", "tool-call-result", "tool_use", "tool_result",
        "token_count", "ready", "thread_id_changed",
        "agent_message_delta", "agent_reasoning_delta", "task_started",
    )

    /** Null for messages with nothing human-readable to show. */
    fun extractLine(message: DecryptedMessage): WearTranscriptLine? {
        val envelope = message.content as? JsonObject ?: return null
        val role = envelope["role"]?.contentOrNull()?.ifBlank { null } ?: "agent"
        val inner = envelope["content"] as? JsonObject ?: return null
        val raw = extractText(inner) ?: return null
        val text = stripAgentNotifySummary(raw).trim()
        if (text.isEmpty()) return null
        return WearTranscriptLine(role = role, text = text, createdAt = message.createdAt)
    }

    private fun extractText(inner: JsonObject): String? {
        inner["text"]?.contentOrNull()?.takeIf { it.isNotBlank() }?.let { return it }

        val data = inner["data"] as? JsonObject ?: return null
        val type = data["type"]?.contentOrNull()
        if (type in NON_TEXT_EVENT_TYPES) return null

        val messageElement = data["message"]
        val messageObject = messageElement as? JsonObject
        if (messageObject != null) {
            val blocks = messageObject["content"] as? JsonArray ?: return null
            val text = blocks.mapNotNull { block ->
                val obj = block as? JsonObject ?: return@mapNotNull null
                if (obj["type"]?.contentOrNull() != "text") return@mapNotNull null
                obj["text"]?.contentOrNull()?.takeIf { it.isNotBlank() }
            }.joinToString("\n\n")
            return text.ifEmpty { null }
        }

        val messageString = messageElement?.contentOrNull()
        if (!messageString.isNullOrBlank() && !messageString.startsWith("{") && !messageString.startsWith("[")) {
            return messageString
        }
        return null
    }

    /**
     * Strips a trailing `AGENT_NOTIFY_SUMMARY {...}` contract line
     * (`shared/src/messages.ts` -> `extractNotifySummary`). Only when it is
     * the *last* non-blank line — a user message that merely discusses the
     * marker mid-text is left untouched.
     */
    internal fun stripAgentNotifySummary(text: String): String {
        if ("AGENT_NOTIFY_SUMMARY" !in text) return text
        val lines = text.split('\n')
        val lastIdx = lines.indices.lastOrNull { lines[it].isNotBlank() } ?: return text
        val candidate = lines[lastIdx].trim()
        if (!candidate.startsWith("AGENT_NOTIFY_SUMMARY")) return text
        val tail = candidate.removePrefix("AGENT_NOTIFY_SUMMARY").trimStart()
        if (!tail.startsWith("{") || !tail.endsWith("}")) return text
        var keepUntil = lastIdx
        while (keepUntil > 0 && lines[keepUntil - 1].isBlank()) keepUntil -= 1
        return lines.subList(0, keepUntil).joinToString("\n")
    }

    private fun JsonElement.contentOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
}

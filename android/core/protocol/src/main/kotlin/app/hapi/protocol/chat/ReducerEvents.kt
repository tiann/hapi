package app.hapi.protocol.chat

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Port of `web/src/chat/reducerEvents.ts`. */

private val LIMIT_REACHED_REGEX = Regex("^Claude AI usage limit reached\\|(\\d+)(?:\\|([^|]*))?$")
private val LIMIT_WARNING_REGEX = Regex("^Claude AI usage limit warning\\|(\\d+)\\|(\\d+)\\|([^|]*)$")

/** JS `Number.parseInt(s, 10)` for `\d+` captures (falls to Double past Long range). */
private fun parsePipeInt(text: String): Double? =
    text.toLongOrNull()?.toDouble() ?: text.toDoubleOrNull()

private fun parseClaudeUsageLimit(text: String): AgentEvent? {
    val reachedMatch = LIMIT_REACHED_REGEX.find(text)
    if (reachedMatch != null) {
        val timestamp = parsePipeInt(reachedMatch.groupValues[1])
        if (timestamp != null && timestamp.isFinite()) {
            return AgentEvent.of(buildJsonObject {
                put("type", "limit-reached")
                put("endsAt", jsNumber(timestamp))
                // TS `reachedMatch[2] || ''` — an unmatched or empty group becomes ''.
                put("limitType", reachedMatch.groupValues[2])
            })
        }
    }

    val warningMatch = LIMIT_WARNING_REGEX.find(text)
    if (warningMatch != null) {
        val timestamp = parsePipeInt(warningMatch.groupValues[1])
        val utilizationInt = parsePipeInt(warningMatch.groupValues[2])
        val limitType = warningMatch.groupValues[3]
        if (timestamp != null && utilizationInt != null) {
            return AgentEvent.of(buildJsonObject {
                put("type", "limit-warning")
                put("utilization", jsNumber(utilizationInt / 100.0))
                put("endsAt", jsNumber(timestamp))
                put("limitType", limitType)
            })
        }
    }

    return null
}

fun parseMessageAsEvent(msg: NormalizedMessage): AgentEvent? {
    if (msg.isSidechain) return null
    val agent = msg as? NormalizedMessage.Agent ?: return null

    for (content in agent.content) {
        if (content is NormalizedAgentContent.Text) {
            val limitEvent = parseClaudeUsageLimit(content.text)
            if (limitEvent != null) {
                return limitEvent
            }
        }
    }

    return null
}

fun dedupeAgentEvents(blocks: List<ChatBlock>): List<ChatBlock> {
    val result = mutableListOf<ChatBlock>()
    var prevEventKey: String? = null
    var prevTitleChangedTo: String? = null

    for (block in blocks) {
        if (block !is AgentEventBlock) {
            result.add(block)
            prevEventKey = null
            prevTitleChangedTo = null
            continue
        }

        val event = block.event
        if (event is AgentEvent.TitleChanged && event.title != null) {
            val title = event.title!!.trim()
            val key = "title-changed:$title"
            if (key == prevEventKey) {
                continue
            }
            result.add(block)
            prevEventKey = key
            prevTitleChangedTo = title
            continue
        }

        if (event is AgentEvent.Message && event.message != null) {
            val message = event.message!!.trim()
            val key = "message:$message"
            if (key == prevEventKey) {
                continue
            }
            if (prevTitleChangedTo != null && message == prevTitleChangedTo) {
                continue
            }
            result.add(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        if (event is AgentEvent.ErrorEvent && event.message != null) {
            val message = event.message!!.trim()
            val key = "error:$message"
            if (key == prevEventKey) {
                continue
            }
            result.add(block)
            prevEventKey = key
            prevTitleChangedTo = null
            continue
        }

        // TS: `event:${JSON.stringify(event)}` — kotlinx JsonObject.toString()
        // is insertion-ordered standard JSON, an equality-faithful analogue.
        val key = "event:${event.raw}"

        if (key == prevEventKey) {
            continue
        }

        result.add(block)
        prevEventKey = key
        prevTitleChangedTo = null
    }

    return result
}

/** Fold consecutive api-error events, keeping only the latest state. */
fun foldApiErrorEvents(blocks: List<ChatBlock>): List<ChatBlock> {
    val result = mutableListOf<ChatBlock>()

    for (block in blocks) {
        if (block !is AgentEventBlock) {
            result.add(block)
            continue
        }

        if (block.event.type != "api-error") {
            result.add(block)
            continue
        }

        val prev = result.lastOrNull()
        if (prev is AgentEventBlock && prev.event.type == "api-error") {
            result[result.size - 1] = block
        } else {
            result.add(block)
        }
    }

    return result
}

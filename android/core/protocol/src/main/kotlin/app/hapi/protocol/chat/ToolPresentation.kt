package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.floor
import kotlin.math.roundToLong

/**
 * Port of `web/src/chat/presentation.ts` — event-row labels and duration/token
 * formatting. Render-only (none of it is in the fixture projection; the
 * README explicitly leaves presentation derivable per platform), so the
 * date/time pieces use java.time defaults instead of the browser's
 * `toLocaleString` while keeping the same structure and rules.
 */

data class EventPresentation(
    val icon: String?,
    val text: String,
)

private fun normalizeTimestamp(value: Double): Instant {
    val ms = if (value < 1_000_000_000_000.0) value * 1000 else value
    return Instant.ofEpochMilli(ms.toLong())
}

fun formatUnixTimestamp(value: Double, zone: ZoneId = ZoneId.systemDefault()): String {
    val date = ZonedDateTime.ofInstant(normalizeTimestamp(value), zone)
    return date.format(DateTimeFormatter.ofPattern("yyyy/M/d HH:mm:ss"))
}

fun formatResetTime(value: Double, zone: ZoneId = ZoneId.systemDefault(), today: LocalDate = LocalDate.now(zone)): String {
    val date = ZonedDateTime.ofInstant(normalizeTimestamp(value), zone)
    return if (date.toLocalDate() == today) {
        date.format(DateTimeFormatter.ofPattern("H:mm"))
    } else {
        date.format(DateTimeFormatter.ofPattern("MMM d, H:mm"))
    }
}

/** Known types: five_hour → "5-hour", seven_day → "7-day"; else underscores become spaces. */
private fun formatLimitType(limitType: String?): String {
    if (limitType.isNullOrEmpty()) return ""
    if (limitType == "five_hour") return "5-hour"
    if (limitType == "seven_day") return "7-day"
    return limitType.replace("_", " ")
}

fun formatDuration(ms: Double): String {
    val seconds = ms / 1000
    if (seconds < 60) return "%.1fs".format(seconds)
    val mins = floor(seconds / 60).toLong()
    val secs = (seconds % 60).roundToLong()
    return "${mins}m ${secs}s"
}

private fun formatTokenCount(value: Double): String {
    if (value >= 1_000_000) return "%.1fM".format(value / 1_000_000)
    if (value >= 10_000) return "%.1fk".format(value / 1_000)
    if (value >= 1_000) return "${(value / 1_000).roundToLong()}k"
    return formatJsNumber(value)
}

private fun formatGoalStatus(status: String): String = when (status) {
    "active" -> "active"
    "paused" -> "paused"
    "budgetLimited" -> "limited by budget"
    "usageLimited" -> "limited by usage"
    "blocked" -> "blocked"
    "complete" -> "complete"
    else -> status
}

private fun formatThreadGoalEvent(event: AgentEvent): EventPresentation {
    val goal = asObject(event.raw["goal"]) ?: return EventPresentation(icon = null, text = "Goal updated")
    val status = asString(goal["status"]) ?: "updated"
    val tokensUsed = asNumber(goal["tokensUsed"].orNull() ?: goal["tokens_used"])
    val tokenBudget = asNumber(goal["tokenBudget"].orNull() ?: goal["token_budget"])
    val parts = mutableListOf("Goal ${formatGoalStatus(status)}")
    if (tokensUsed != null && tokenBudget != null) {
        parts.add("${formatTokenCount(tokensUsed)} / ${formatTokenCount(tokenBudget)}")
    }
    return EventPresentation(icon = null, text = parts.joinToString(" · "))
}

private fun formatTokenCountEvent(event: AgentEvent): EventPresentation {
    val info: JsonObject? = asObject(event.raw["info"])
    val total = info?.let { asObject(it["total"]) } ?: info
        ?: return EventPresentation(icon = "◷", text = "Context updated")

    val inputTokens = asNumber(total["inputTokens"].orNull() ?: total["input_tokens"])
    val outputTokens = asNumber(total["outputTokens"].orNull() ?: total["output_tokens"])
    val cachedTokens = asNumber(
        total["cachedInputTokens"].orNull() ?: total["cacheReadInputTokens"].orNull() ?: total["cache_read_input_tokens"]
    )
    val reasoningTokens = asNumber(total["reasoningOutputTokens"].orNull() ?: total["reasoning_output_tokens"])
    val contextWindow = asNumber(info?.get("modelContextWindow").orNull() ?: info?.get("model_context_window"))

    val parts = mutableListOf<String>()
    if (inputTokens != null && contextWindow != null) {
        val pct = Math.round(inputTokens / contextWindow * 100)
        parts.add("Context ${formatTokenCount(inputTokens)} / ${formatTokenCount(contextWindow)} ($pct%)")
    } else if (inputTokens != null) {
        parts.add("Context ${formatTokenCount(inputTokens)}")
    } else {
        parts.add("Context updated")
    }

    if (outputTokens != null) parts.add("out ${formatTokenCount(outputTokens)}")
    if (cachedTokens != null && cachedTokens > 0) parts.add("cached ${formatTokenCount(cachedTokens)}")
    if (reasoningTokens != null && reasoningTokens > 0) parts.add("reasoning ${formatTokenCount(reasoningTokens)}")

    return EventPresentation(icon = "◷", text = parts.joinToString(" · "))
}

private fun apiErrorDetail(error: kotlinx.serialization.json.JsonElement?): String? {
    asString(error)?.let { return it.trim().takeIf(String::isNotEmpty) }
    val record = asObject(error) ?: return null
    if (!record.containsKey("message")) return null
    return asString(record["message"])?.trim()?.takeIf(String::isNotEmpty)
}

@Suppress("CyclomaticComplexMethod")
fun getEventPresentation(event: AgentEvent): EventPresentation {
    val raw = event.raw
    when (event.type) {
        "api-error" -> {
            val retryAttempt = asNumber(raw["retryAttempt"]) ?: 0.0
            val maxRetries = asNumber(raw["maxRetries"]) ?: 0.0
            if (maxRetries > 0 && retryAttempt >= maxRetries) {
                return EventPresentation(icon = "⚠️", text = "API error: Max retries reached")
            }
            if (maxRetries > 0) {
                return EventPresentation(
                    icon = "⏳",
                    text = "API error: Retrying (${formatJsNumber(retryAttempt)}/${formatJsNumber(maxRetries)})",
                )
            }
            if (retryAttempt > 0) {
                val detail = apiErrorDetail(raw["error"])
                return EventPresentation(
                    icon = "⏳",
                    text = if (detail != null) "API error: Retrying... $detail" else "API error: Retrying...",
                )
            }
            return EventPresentation(icon = "⚠️", text = "API error")
        }
        "switch" -> {
            val mode = if (asString(raw["mode"]) == "local") "local" else "remote"
            return EventPresentation(icon = "🔄", text = "Switched to $mode")
        }
        "title-changed" -> {
            val title = asString(raw["title"]) ?: ""
            return EventPresentation(icon = null, text = if (title.isNotEmpty()) "Title changed to \"$title\"" else "Title changed")
        }
        "permission-mode-changed" -> {
            val mode = asString(raw["mode"]) ?: "default"
            return EventPresentation(icon = "🔐", text = "Permission mode: $mode")
        }
        "limit-warning" -> {
            val pct = Math.round((asNumber(raw["utilization"]) ?: 0.0) * 100)
            val endsAt = asNumber(raw["endsAt"])
            val typeLabel = formatLimitType(asString(raw["limitType"]))
            val suffix = if (typeLabel.isNotEmpty()) " ($typeLabel)" else ""
            return EventPresentation(
                icon = "⚠️",
                text = if (endsAt != null) "Usage limit $pct%$suffix · resets ${formatResetTime(endsAt)}" else "Usage limit $pct%$suffix",
            )
        }
        "limit-reached" -> {
            val endsAt = asNumber(raw["endsAt"])
            val typeLabel = formatLimitType(asString(raw["limitType"]))
            val suffix = if (typeLabel.isNotEmpty()) " ($typeLabel)" else ""
            return EventPresentation(
                icon = "⏳",
                text = if (endsAt != null) "Usage limit reached$suffix until ${formatUnixTimestamp(endsAt)}" else "Usage limit reached$suffix",
            )
        }
        "error" -> return EventPresentation(icon = "⚠️", text = asString(raw["message"]) ?: "Error")
        "message" -> return EventPresentation(icon = null, text = asString(raw["message"]) ?: "Message")
        "turn-duration" -> {
            val ms = asNumber(raw["durationMs"]) ?: 0.0
            return EventPresentation(icon = "⏱️", text = "Turn: ${formatDuration(ms)}")
        }
        "microcompact" -> {
            val saved = asNumber(raw["tokensSaved"]) ?: 0.0
            val formatted = if (saved >= 1000) "${Math.round(saved / 1000)}K" else formatJsNumber(saved)
            return EventPresentation(icon = "📦", text = "Context compacted (saved $formatted tokens)")
        }
        "compact" -> return EventPresentation(icon = "📦", text = "Conversation compacted")
        "compact-summary" -> return EventPresentation(icon = "📦", text = "Context compacted")
        "recap" -> {
            val text = asString(raw["text"]) ?: ""
            return EventPresentation(icon = "💭", text = "recap: $text")
        }
        "thread-goal-updated" -> return formatThreadGoalEvent(event)
        "thread-goal-cleared" -> return EventPresentation(icon = null, text = "Goal cleared")
        "token-count" -> return formatTokenCountEvent(event)
    }
    return EventPresentation(icon = null, text = raw.toString())
}

fun renderEventLabel(event: AgentEvent): String = getEventPresentation(event).text

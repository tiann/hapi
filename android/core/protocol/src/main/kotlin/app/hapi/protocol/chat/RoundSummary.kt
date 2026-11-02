package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.floor

/**
 * Per-model token counters carried on a round summary. Every counter is
 * optional; a model entry may legitimately hold none of them.
 */
data class RoundModelUsage(
    val inputTokens: Double? = null,
    val outputTokens: Double? = null,
    val cacheReadInputTokens: Double? = null,
    val cacheCreationInputTokens: Double? = null,
)

/**
 * Usage/cost/latency summary of one agent round, attached to the first
 * block of the trailing summary-target group.
 *
 * [modelUsage] preserves insertion order (model ids are listed in that
 * order when rendered).
 */
data class RoundSummary(
    /** Currently only `"codex"` — summaries synthesized from native turns. */
    val provider: String? = null,
    val turnId: String? = null,
    val usage: UsageData? = null,
    val modelUsage: Map<String, RoundModelUsage> = emptyMap(),
    val totalCostUsd: Double? = null,
    val numTurns: Double? = null,
    val durationMs: Double? = null,
)

/** Finite number >= 0, else null. */
internal fun nonNegativeNumber(value: JsonElement?): Double? {
    val number = asNumber(value) ?: return null
    return if (number.isFinite() && number >= 0) number else null
}

private fun nonNegativeSafeInteger(value: JsonElement?): Double? {
    val number = asNumber(value) ?: return null
    return if (number.isFinite() && number == floor(number) &&
        abs(number) <= 9.007199254740991E15 && number >= 0
    ) {
        number
    } else {
        null
    }
}

private fun normalizeResultUsage(value: JsonElement?): UsageData? {
    val obj = asObject(value) ?: return null
    val inputTokens = nonNegativeSafeInteger(obj["input_tokens"])
    val outputTokens = nonNegativeSafeInteger(obj["output_tokens"])
    if (inputTokens == null || outputTokens == null) return null
    return UsageData(
        inputTokens = inputTokens,
        outputTokens = outputTokens,
        cacheCreationInputTokens = nonNegativeSafeInteger(obj["cache_creation_input_tokens"]),
        cacheReadInputTokens = nonNegativeSafeInteger(obj["cache_read_input_tokens"]),
    )
}

/**
 * Decode a wire `resultSummary` object. Invalid or absent counters become
 * null; a summary with no usable signal at all returns null so the caller
 * falls back to the plain turn-duration event.
 */
internal fun normalizeRoundSummary(value: JsonElement?): RoundSummary? {
    val obj = asObject(value) ?: return null

    val parsedModelUsage = mutableListOf<Pair<String, RoundModelUsage>>()
    asObject(obj["modelUsage"])?.forEach { (model, rawUsage) ->
        val usageObj = asObject(rawUsage) ?: return@forEach
        parsedModelUsage.add(
            model to RoundModelUsage(
                inputTokens = nonNegativeSafeInteger(usageObj["inputTokens"]),
                outputTokens = nonNegativeSafeInteger(usageObj["outputTokens"]),
                cacheReadInputTokens = nonNegativeSafeInteger(usageObj["cacheReadInputTokens"]),
                cacheCreationInputTokens = nonNegativeSafeInteger(usageObj["cacheCreationInputTokens"]),
            )
        )
    }
    val hasModelTokens = parsedModelUsage.any { (_, usage) ->
        usage.inputTokens != null || usage.outputTokens != null ||
            usage.cacheReadInputTokens != null || usage.cacheCreationInputTokens != null
    }
    val modelUsage = LinkedHashMap<String, RoundModelUsage>()
    if (hasModelTokens) {
        parsedModelUsage.forEach { (model, usage) -> modelUsage[model] = usage }
    }

    val usage = normalizeResultUsage(obj["usage"])
    // The three scalars accept both the wire casing (snake) and the casing
    // used inside synthesized turn-summary event payloads (camel), so a
    // summary survives its round trip through the event stream.
    val totalCostUsd = nonNegativeNumber(obj["total_cost_usd"].orNull() ?: obj["totalCostUsd"])
    val numTurns = nonNegativeSafeInteger(obj["num_turns"].orNull() ?: obj["numTurns"])
    val durationMs = nonNegativeNumber(obj["duration_ms"].orNull() ?: obj["durationMs"])
    if (usage == null && modelUsage.isEmpty() && totalCostUsd == null && numTurns == null && durationMs == null) {
        return null
    }

    return RoundSummary(
        usage = usage,
        modelUsage = modelUsage,
        totalCostUsd = if (totalCostUsd != null && totalCostUsd > 0) totalCostUsd else null,
        numTurns = if (numTurns != null && numTurns > 0) numTurns else null,
        durationMs = durationMs,
    )
}

/**
 * Serialize a [RoundSummary] for a synthesized event payload. Absent
 * fields are omitted, mirroring how undefined keys drop out of the
 * equivalent object literal.
 */
internal fun roundSummaryToJson(summary: RoundSummary): JsonObject = buildJsonObject {
    summary.provider?.let { put("provider", it) }
    summary.turnId?.let { put("turnId", it) }
    summary.usage?.let { usage ->
        put(
            "usage",
            buildJsonObject {
                put("input_tokens", jsNumber(usage.inputTokens))
                put("output_tokens", jsNumber(usage.outputTokens))
                usage.cacheCreationInputTokens?.let { put("cache_creation_input_tokens", jsNumber(it)) }
                usage.cacheReadInputTokens?.let { put("cache_read_input_tokens", jsNumber(it)) }
            }
        )
    }
    if (summary.modelUsage.isNotEmpty()) {
        put(
            "modelUsage",
            buildJsonObject {
                summary.modelUsage.forEach { (model, usage) ->
                    put(
                        model,
                        buildJsonObject {
                            usage.inputTokens?.let { put("inputTokens", jsNumber(it)) }
                            usage.outputTokens?.let { put("outputTokens", jsNumber(it)) }
                            usage.cacheReadInputTokens?.let { put("cacheReadInputTokens", jsNumber(it)) }
                            usage.cacheCreationInputTokens?.let { put("cacheCreationInputTokens", jsNumber(it)) }
                        }
                    )
                }
            }
        )
    }
    summary.totalCostUsd?.let { put("totalCostUsd", jsNumber(it)) }
    summary.numTurns?.let { put("numTurns", jsNumber(it)) }
    summary.durationMs?.let { put("durationMs", jsNumber(it)) }
}

/**
 * Decode a summary previously stored in a synthesized event payload.
 * Accepts both the wire shape and the normalized shape.
 */
internal fun decodeRoundSummary(value: JsonElement?): RoundSummary? {
    val summary = normalizeRoundSummary(value) ?: return null
    val obj = asObject(value) ?: return summary
    return summary.copy(
        provider = asString(obj["provider"]),
        turnId = asString(obj["turnId"]),
    )
}

/**
 * Blocks that can carry a round summary: everything except user text,
 * agent events, and user-sourced CLI output.
 */
internal fun isRoundSummaryTarget(block: ChatBlock): Boolean =
    block !is UserTextBlock &&
        block !is AgentEventBlock &&
        !(block is CliOutputBlock && block.source == "user")

internal fun roundSummaryOf(block: ChatBlock): RoundSummary? = when (block) {
    is AgentTextBlock -> block.roundSummary
    is AgentReasoningBlock -> block.roundSummary
    is CodexReviewBlock -> block.roundSummary
    is CliOutputBlock -> block.roundSummary
    is GeneratedImageBlock -> block.roundSummary
    is ToolCallBlock -> block.roundSummary
    else -> null
}

internal fun setRoundSummary(block: ChatBlock, summary: RoundSummary?) {
    when (block) {
        is AgentTextBlock -> block.roundSummary = summary
        is AgentReasoningBlock -> block.roundSummary = summary
        is CodexReviewBlock -> block.roundSummary = summary
        is CliOutputBlock -> block.roundSummary = summary
        is GeneratedImageBlock -> block.roundSummary = summary
        is ToolCallBlock -> block.roundSummary = summary
        else -> {}
    }
}

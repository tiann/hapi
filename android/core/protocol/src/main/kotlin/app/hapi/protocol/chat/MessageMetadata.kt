package app.hapi.protocol.chat

import java.util.Locale

/**
 * Metadata shown in a per-message details popup: model, token counters,
 * cost, and round timing. Mirrors the label contract of the message
 * metadata footer: every row is a pre-formatted line; an empty list means
 * the message carries no usage signal at all.
 */
data class MessageMetadataInput(
    val durationMs: Double? = null,
    val usage: UsageData? = null,
    val model: String? = null,
    /** Distinct turn count of the surrounding response group (>= 2 = aggregated). */
    val turnCount: Int? = null,
    val roundSummary: RoundSummary? = null,
)

/**
 * Build the metadata label lines for one message. A round summary, when
 * present, wins entirely over the per-message fields; otherwise the lines
 * describe the single message (or the summed response group when
 * [MessageMetadataInput.turnCount] is at least 2).
 */
fun buildMessageMetadataLabels(metadata: MessageMetadataInput): List<String> {
    val roundSummary = metadata.roundSummary
    if (roundSummary != null) return buildRoundSummaryLabels(roundSummary, metadata.model)

    val parts = mutableListOf<String>()
    val isAggregated = metadata.turnCount != null && metadata.turnCount >= 2

    val durationMs = metadata.durationMs
    if (durationMs != null && durationMs >= 0) {
        parts.add("Duration: ${formatMetadataDuration(durationMs)}")
    }

    val usage = metadata.usage
    val tier = usage?.serviceTier
    val isStandardTier = tier?.lowercase() == "standard"
    val model = metadata.model
    if (model != null) {
        val modelLabel = if (isAggregated && model.contains(", ")) "Models" else "Model"
        var label = "$modelLabel: $model"
        if (tier != null && !isStandardTier) label += " ($tier)"
        parts.add(label)
    } else if (tier != null && !isStandardTier) {
        parts.add("Tier: $tier")
    }

    if (usage != null) {
        val total = usage.inputTokens + usage.outputTokens
        parts.add(
            "Tokens: ${formatGroupedNumber(total)} total " +
                "(${formatGroupedNumber(usage.inputTokens)} in / ${formatGroupedNumber(usage.outputTokens)} out)"
        )
    }

    val turnCount = metadata.turnCount
    if (turnCount != null && turnCount >= 2) {
        parts.add("$turnCount turns")
    }

    return parts
}

/** Labels for a whole agent round (cost/tokens/timing across its turns). */
internal fun buildRoundSummaryLabels(summary: RoundSummary, fallbackModel: String?): List<String> {
    val parts = mutableListOf<String>()
    val models = summary.modelUsage.keys.toList()
    val model: String? = if (models.isNotEmpty()) models.joinToString(", ") else fallbackModel
    if (model != null) {
        parts.add("${if (models.size > 1) "Models" else "Model"}: $model")
    }

    val usage = getRoundUsage(summary)
    if (usage != null) {
        val input = usage.inputTokens + (usage.cacheCreationInputTokens ?: 0.0) + (usage.cacheReadInputTokens ?: 0.0)
        val total = input + usage.outputTokens
        parts.add(
            "Tokens: ${formatCompactTokenCount(total)} " +
                "(${formatCompactTokenCount(input)} in · ${formatCompactTokenCount(usage.outputTokens)} out)"
        )

        val economics = mutableListOf<String>()
        val cacheRead = usage.cacheReadInputTokens ?: 0.0
        if (input > 0 && cacheRead > 0) {
            economics.add("Cached input: ${formatPercentage((cacheRead / input) * 100)}%")
        }
        val costUsd = summary.totalCostUsd
        if (costUsd != null && costUsd > 0) {
            economics.add("Cost: ${formatUsd(costUsd)}")
        }
        if (economics.isNotEmpty()) {
            parts.add(economics.joinToString(" · "))
        }
    } else {
        val costUsd = summary.totalCostUsd
        if (costUsd != null && costUsd > 0) {
            parts.add("Cost: ${formatUsd(costUsd)}")
        }
    }

    val round = mutableListOf<String>()
    val durationMs = summary.durationMs
    if (durationMs != null && durationMs >= 0) {
        round.add(formatMetadataDuration(durationMs))
    }
    val numTurns = summary.numTurns
    if (numTurns != null && numTurns > 0) {
        round.add("${formatJsNumber(numTurns)} turn${if (numTurns == 1.0) "" else "s"}")
    }
    if (round.isNotEmpty()) {
        parts.add("Round: ${round.joinToString(" · ")}")
    }
    return parts
}

/** Sum the per-model counters, falling back to the round-level usage. */
private fun getRoundUsage(summary: RoundSummary): UsageData? {
    val entries = summary.modelUsage.values.toList()
    val hasModelToken = entries.any { usage ->
        usage.inputTokens != null || usage.outputTokens != null ||
            usage.cacheReadInputTokens != null || usage.cacheCreationInputTokens != null
    }
    if (!hasModelToken) return summary.usage

    var inputTokens = 0.0
    var outputTokens = 0.0
    var cacheCreation: Double? = null
    var cacheRead: Double? = null
    for (usage in entries) {
        inputTokens += usage.inputTokens ?: 0.0
        outputTokens += usage.outputTokens ?: 0.0
        cacheCreation = (cacheCreation ?: 0.0) + (usage.cacheCreationInputTokens ?: 0.0)
        cacheRead = (cacheRead ?: 0.0) + (usage.cacheReadInputTokens ?: 0.0)
    }
    return UsageData(
        inputTokens = inputTokens,
        outputTokens = outputTokens,
        cacheCreationInputTokens = cacheCreation,
        cacheReadInputTokens = cacheRead,
    )
}

/**
 * Token counter with compact suffix: plain below 1k, one decimal `k`/`m`
 * above. One-decimal steps keep 1.0k readable as "1k".
 */
internal fun formatCompactTokenCount(value: Double): String {
    if (value < 1_000) return formatGroupedNumber(jsRound(value))
    val divisor = if (value >= 1_000_000) 1_000_000.0 else 1_000.0
    val suffix = if (divisor == 1_000_000.0) "m" else "k"
    return formatJsNumber(jsRound((value / divisor) * 10) / 10.0) + suffix
}

internal fun formatPercentage(value: Double): String = formatJsNumber(jsRound(value * 10) / 10.0)

internal fun formatUsd(value: Double): String {
    if (value < 0.0001) return "<$0.0001"
    return if (value >= 0.01) {
        "$" + String.format(Locale.US, "%.3f", value)
    } else {
        "$" + String.format(Locale.US, "%.4f", value)
    }
}

/**
 * Duration with sub-minute precision in seconds, whole m/h/s segments
 * above. Always uses the dot decimal separator.
 */
internal fun formatMetadataDuration(ms: Double): String {
    val seconds = ms / 1000
    if (seconds < 60) return String.format(Locale.US, "%.1fs", seconds)

    val totalSeconds = jsRound(seconds)
    val hours = (totalSeconds / 3_600).toLong()
    val minutes = ((totalSeconds % 3_600) / 60).toLong()
    val remainingSeconds = (totalSeconds % 60).toLong()
    val parts = mutableListOf<String>()
    if (hours > 0) parts.add("${hours}h")
    if (minutes > 0) parts.add("${minutes}m")
    if (remainingSeconds > 0) parts.add("${remainingSeconds}s")
    return parts.joinToString(" ")
}

/** Integer with en-US grouping (`1,234`), matching `toLocaleString()`. */
internal fun formatGroupedNumber(value: Double): String = String.format(Locale.US, "%,d", jsRound(value).toLong())

/** JS `Math.round` — halfway cases round toward +infinity. */
private fun jsRound(value: Double): Double = Math.round(value).toDouble()

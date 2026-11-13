package app.hapi.companion.feature.chat

import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.AggregatedAssistantMeta
import app.hapi.protocol.chat.ChatBlock
import app.hapi.protocol.chat.CliOutputBlock
import app.hapi.protocol.chat.CodexReview
import app.hapi.protocol.chat.CodexReviewBlock
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.buildMessageMetadataLabels
import app.hapi.protocol.chat.messageMetadataForBlock
import app.hapi.protocol.chat.visibleBlockRole

/**
 * The action row closing one agent response (web `MessageActions` on an
 * assistant-ui card): copy, details and time, shown once under the LAST
 * block of each run of assistant-role blocks — runs are bounded by user
 * text, agent events and user-source CLI output, exactly like the web card
 * join and [app.hapi.protocol.chat.aggregateResponseGroups].
 *
 * @property copyText the run's prose (agent text, assistant CLI output, Codex
 *   review), each part trimmed and joined by a blank line; reasoning and
 *   tools are excluded (web `getAssistantCopyText`). Null when there is none.
 * @property detailsBlock the block whose metadata the details dialog shows:
 *   the run's first block (which carries the group aggregate), or the first
 *   block with any usage labels when the first has none.
 * @property timestamp the run's latest activity (web `getResponseGroupTimestamps`).
 */
internal data class ResponseFooter(
    val copyText: String?,
    val detailsBlock: VisibleChatBlock?,
    val timestamp: Long,
)

/** Footers keyed by the stable id of each run's last block. */
internal fun buildResponseFooters(
    blocks: List<VisibleChatBlock>,
    aggregates: Map<String, AggregatedAssistantMeta>,
): Map<String, ResponseFooter> {
    val footers = HashMap<String, ResponseFooter>()
    var run = ArrayList<VisibleChatBlock>()

    fun flush() {
        val last = run.lastOrNull() ?: return
        val text = run.mapNotNull(::copyablePart).joinToString("\n\n").ifEmpty { null }
        val details = run.firstOrNull { hasDetails(it, aggregates) }
        footers[last.stableId] = ResponseFooter(
            copyText = text,
            detailsBlock = details,
            timestamp = run.maxOf(::activityTimestamp),
        )
        run = ArrayList()
    }

    for (block in blocks) {
        if (visibleBlockRole(block) == "assistant") run.add(block) else flush()
    }
    flush()
    return footers
}

private fun copyablePart(block: VisibleChatBlock): String? = when (block) {
    is AgentTextBlock -> block.text
    is CliOutputBlock -> block.text
    is CodexReviewBlock -> formatCodexReviewText(block.review)
    else -> null
}?.trim()?.ifEmpty { null }

/** Port of web `formatCodexReviewText` (assistant-runtime.ts), the review card's copy text. */
internal fun formatCodexReviewText(review: CodexReview): String {
    val lines = mutableListOf("Codex review")
    review.overallCorrectness?.takeIf { it.isNotEmpty() }?.let { lines += "Overall: $it" }
    review.overallExplanation?.takeIf { it.isNotEmpty() }?.let { lines += listOf("", it) }
    if (review.findings.isNotEmpty()) {
        lines += listOf("", "Findings:")
        for (finding in review.findings) {
            val priority = finding.priority?.let { "[P${formatNumber(it)}] " }.orEmpty()
            val location = finding.filePath?.takeIf { it.isNotEmpty() }?.let { path ->
                val start = finding.lineStart
                val end = finding.lineEnd
                val range = when {
                    start == null -> ""
                    end != null && end != start -> ":${formatNumber(start)}-${formatNumber(end)}"
                    else -> ":${formatNumber(start)}"
                }
                " ($path$range)"
            }.orEmpty()
            lines += "- $priority${finding.title}$location"
            lines += "  ${finding.body}"
        }
    }
    return lines.joinToString("\n")
}

/** JS number formatting for integral wire doubles (`1.0` → `1`). */
private fun formatNumber(value: Double): String =
    if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()

private fun hasDetails(block: VisibleChatBlock, aggregates: Map<String, AggregatedAssistantMeta>): Boolean =
    messageMetadataForBlock(block, aggregates)?.let(::buildMessageMetadataLabels).orEmpty().isNotEmpty()

/** Latest activity of one block (tools finish after they start). */
private fun activityTimestamp(block: VisibleChatBlock): Long = when (block) {
    is ToolGroupBlock -> block.tools.fold(block.createdAt) { latest, tool ->
        maxOf(latest, tool.tool.completedAt?.toLong() ?: tool.createdAt)
    }
    is ToolCallBlock -> maxOf(block.createdAt, block.tool.completedAt?.toLong() ?: block.createdAt)
    is ChatBlock -> block.createdAt
}

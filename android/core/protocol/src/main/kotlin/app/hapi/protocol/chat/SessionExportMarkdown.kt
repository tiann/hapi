package app.hapi.protocol.chat

import app.hapi.protocol.wire.SessionExport
import kotlinx.serialization.json.JsonNull

/**
 * Port of `web/src/lib/sessionExport/markdown.ts` — the readable Markdown
 * outlet of a session export, built on the same normalize/presentation
 * pipeline the transcript uses. Reasoning blocks are always included; the
 * sidechain is always dropped; tool input/results are single-line and
 * truncated (160/240) exactly like the web twin.
 */

/** `getSessionTitle` (markdown.ts variant): truthy name → summary → path tail → id[:8]. */
private fun getSessionTitle(export: SessionExport): String {
    val metadata = export.session.metadata ?: return export.session.id.take(8)
    if (!metadata.name.isNullOrEmpty()) return metadata.name
    val summary = metadata.summary?.text
    if (!summary.isNullOrEmpty()) return summary
    if (metadata.path.isNotEmpty()) {
        val parts = metadata.path.split('/').filter { it.isNotEmpty() }
        return parts.lastOrNull() ?: metadata.path
    }
    return export.session.id.take(8)
}

private fun escapeYamlString(value: String): String = value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")
    .replace("\r", "\\r")
    .replace("\n", "\\n")

private fun formatFrontMatter(export: SessionExport, title: String): String {
    val metadata = export.session.metadata
    val lines = mutableListOf(
        "---",
        "title: \"${escapeYamlString(title)}\"",
        "sessionId: \"${escapeYamlString(export.session.id)}\"",
        "exportedAt: \"${formatExportTimestamp(export.exportedAt)}\"",
        "messageCount: ${export.messages.size}",
        "scratchlistCount: ${export.scratchlist.size}",
    )
    metadata?.path?.let { lines.add("path: \"${escapeYamlString(it)}\"") }
    metadata?.host?.let { lines.add("host: \"${escapeYamlString(it)}\"") }
    metadata?.flavor?.let { lines.add("agent: \"${escapeYamlString(it)}\"") }
    lines.add("---")
    return lines.joinToString("\n")
}

private fun formatScratchlistSection(export: SessionExport): String? {
    if (export.scratchlist.isEmpty()) return null
    val blocks = mutableListOf("## Scratchlist")
    for (entry in export.scratchlist) {
        val timestamp = formatExportTimestamp(entry.createdAt)
        val attachments = if (entry.attachments.isNotEmpty()) {
            "\n\n" + entry.attachments.joinToString("\n") { attachment ->
                "- Attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes)"
            }
        } else {
            ""
        }
        blocks.add("### Note\n\n_Time: ${timestamp}_\n\n${entry.text}${attachments}")
    }
    return blocks.joinToString("\n\n")
}

private fun truncateExportText(value: String, maxLength: Int): String =
    if (value.length <= maxLength) value else value.take(maxLength - 1) + "…"

private val WHITESPACE_RUN = Regex("\\s+")

private fun collapseWhitespace(value: String): String = WHITESPACE_RUN.replace(value, " ")

private fun formatToolInput(input: kotlinx.serialization.json.JsonElement?): String {
    // TS `input == null` folds absent and explicit null; both render as no suffix.
    if (input == null || input is JsonNull) return ""
    val text = safeStringify(input).trim()
    return if (text.isNotEmpty()) " — ${truncateExportText(collapseWhitespace(text), 160)}" else ""
}

private fun formatAgentContentBlock(block: NormalizedAgentContent): String? = when (block) {
    is NormalizedAgentContent.Text -> block.text
    is NormalizedAgentContent.Reasoning -> "> Reasoning: ${block.text}"
    is NormalizedAgentContent.ToolUse -> "- Tool: ${block.name}${formatToolInput(block.input)}"
    is NormalizedAgentContent.ToolResult -> {
        val label = if (block.isError) "Tool error" else "Tool result"
        val content = safeStringify(block.content).trim()
        if (content.isNotEmpty()) "- $label: ${truncateExportText(collapseWhitespace(content), 240)}" else "- $label"
    }
    is NormalizedAgentContent.GeneratedImage -> "- Generated image: ${block.fileName}"
    is NormalizedAgentContent.CodexReviewContent ->
        "- Codex review: ${block.review.overallCorrectness ?: "review"} (${block.review.findings.size} findings)"
    is NormalizedAgentContent.Summary -> "> Summary: ${block.summary}"
    is NormalizedAgentContent.Sidechain -> null
}

private fun formatNormalizedMessage(message: NormalizedMessage): String? {
    val timestamp = formatExportTimestamp(message.createdAt)
    if (message is NormalizedMessage.User) {
        val attachments = message.attachments?.takeIf { it.isNotEmpty() }?.let { list ->
            "\n\n" + list.joinToString("\n") { attachment ->
                "- Attachment: ${attachment.filename} (${attachment.mimeType}, ${formatJsNumber(attachment.size)} bytes)"
            }
        } ?: ""
        return "## User\n\n_Time: ${timestamp}_\n\n${message.text}${attachments}"
    }
    if (message is NormalizedMessage.Event) {
        return "## Event\n\n_Time: ${timestamp}_\n\n${renderEventLabel(message.event)}"
    }
    val parts = (message as NormalizedMessage.Agent).content
        .mapNotNull(::formatAgentContentBlock)
        .filter { it.trim().isNotEmpty() }
    if (parts.isEmpty()) return null
    return "## Assistant\n\n_Time: ${timestamp}_\n\n${parts.joinToString("\n\n")}"
}

/** `serializeSessionMarkdown` — the whole document, sections joined by blank lines. */
fun serializeSessionMarkdown(export: SessionExport): String {
    val title = getSessionTitle(export)
    val sections = mutableListOf(
        formatFrontMatter(export, title),
        "# $title",
        "Session: `${export.session.id}`",
        "Exported: ${formatExportTimestamp(export.exportedAt)}",
    )
    formatScratchlistSection(export)?.let { sections.add(it) }
    for (message in export.messages) {
        val normalized = normalizeDecryptedMessage(message) ?: continue
        formatNormalizedMessage(normalized)?.let { sections.add(it) }
    }
    return sections.joinToString("\n\n") + "\n"
}

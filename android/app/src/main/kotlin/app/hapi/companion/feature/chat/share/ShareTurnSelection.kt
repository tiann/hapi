package app.hapi.companion.feature.chat.share

import app.hapi.companion.feature.chat.stableId
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.CliOutputBlock
import app.hapi.protocol.chat.CodexReview
import app.hapi.protocol.chat.CodexReviewBlock
import app.hapi.protocol.chat.GeneratedImageBlock
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock
import app.hapi.protocol.chat.visibleBlockRole

/** Content shape of one renderable piece of a shared turn. */
enum class ShareTurnSegmentKind {
    /** Plain prose rendered with the body text style. */
    TEXT,

    /** Generated-media card rendered as a one-line placeholder. */
    MEDIA,
}

/**
 * One renderable piece of a turn: the user question or a portion of the
 * answer. [role] follows the thread roles (`user` / `assistant`) and decides
 * the visual treatment (right-aligned bubble vs. open text).
 */
data class ShareTurnSegment(
    val role: String,
    val kind: ShareTurnSegmentKind,
    val text: String,
)

/**
 * Boundary + content rules for sharing one question-and-answer turn as a
 * card. All logic is plain Kotlin so the rules stay directly testable.
 *
 * A turn starts at its user message and ends right before the next user
 * message; everything in between belongs to the answer. Blocks that carry
 * intermediate machinery — thinking notes, tool activity, system events —
 * stay inside the boundary for anchoring purposes but never enter the card.
 */
object ShareTurnSelection {

    /**
     * Blocks whose row may anchor a share action: the content block types
     * that can appear in a card. Thinking, tool and event rows cannot.
     */
    fun canAnchorShareTurn(block: VisibleChatBlock): Boolean = when (block) {
        is UserTextBlock, is CliOutputBlock, is AgentTextBlock,
        is GeneratedImageBlock, is CodexReviewBlock,
        -> true

        else -> false
    }

    /**
     * Blocks of the turn containing [target]. The turn starts at [target]
     * itself when it is a user message, otherwise at the nearest user
     * message above it (or at [target] again when none exists in the
     * provided list), and ends right before the next user message. A target
     * missing from the list degrades to just the target block.
     */
    fun selectTurnBlocks(blocks: List<VisibleChatBlock>, target: VisibleChatBlock): List<VisibleChatBlock> {
        val targetIndex = blocks.indexOfFirst { it.stableId == target.stableId }
        if (targetIndex < 0) return listOf(target)

        val start = if (visibleBlockRole(blocks[targetIndex]) == "user") {
            targetIndex
        } else {
            (targetIndex - 1 downTo 0)
                .firstOrNull { visibleBlockRole(blocks[it]) == "user" }
                ?: targetIndex
        }
        val end = (start + 1 until blocks.size)
            .firstOrNull { visibleBlockRole(blocks[it]) == "user" }
            ?: blocks.size
        return blocks.subList(start, end).toList()
    }

    /**
     * Renderable pieces of a turn: user and assistant prose plus generated
     * media placeholders, in thread order. Thinking blocks, tool activity
     * and system events produce nothing; blank texts are dropped.
     */
    fun shareableSegments(blocks: List<VisibleChatBlock>): List<ShareTurnSegment> =
        blocks.mapNotNull(::segmentFor)

    /** Plain-text rendering of a turn, used when image sharing is unavailable. */
    fun plainText(segments: List<ShareTurnSegment>): String =
        segments.joinToString("\n\n") { it.text }

    private fun segmentFor(block: VisibleChatBlock): ShareTurnSegment? = when (block) {
        is UserTextBlock -> textSegment("user", block.text.trim())
        is CliOutputBlock -> textSegment(
            role = if (block.source == "user") "user" else "assistant",
            text = block.text.trim(),
        )

        is AgentTextBlock -> textSegment("assistant", block.text.trim())
        is CodexReviewBlock -> textSegment("assistant", codexReviewText(block.review))
        is GeneratedImageBlock -> {
            val name = block.fileName.trim()
            if (name.isEmpty()) null
            else ShareTurnSegment("assistant", ShareTurnSegmentKind.MEDIA, "🖼 $name")
        }

        else -> null
    }

    private fun textSegment(role: String, text: String): ShareTurnSegment? =
        if (text.isEmpty()) null
        else ShareTurnSegment(role, ShareTurnSegmentKind.TEXT, text)

    /** Review cards enter the card as their explanation plus findings. */
    private fun codexReviewText(review: CodexReview): String = buildString {
        review.overallExplanation?.trim()?.takeIf { it.isNotEmpty() }?.let {
            append(it)
            append("\n\n")
        }
        review.findings.forEach { finding ->
            finding.title.trim().takeIf { it.isNotEmpty() }?.let {
                append("■ ")
                append(it)
                append('\n')
            }
            finding.body.trim().takeIf { it.isNotEmpty() }?.let {
                append(it)
                append("\n\n")
            }
        }
    }.trim()
}

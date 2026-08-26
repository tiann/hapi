package app.hapi.companion.feature.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import app.hapi.companion.feature.chat.blocks.AgentEventBlockView
import app.hapi.companion.feature.chat.blocks.AgentReasoningBlockView
import app.hapi.companion.feature.chat.blocks.AgentTextBlockView
import app.hapi.companion.feature.chat.blocks.CliOutputBlockView
import app.hapi.companion.feature.chat.blocks.CodexReviewBlockView
import app.hapi.companion.feature.chat.blocks.GeneratedImageBlockView
import app.hapi.companion.feature.chat.blocks.ToolCallBlockView
import app.hapi.companion.feature.chat.blocks.ToolGroupBlockView
import app.hapi.companion.feature.chat.blocks.UserTextBlockView
import app.hapi.protocol.chat.AgentEventBlock
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.ChatBlock
import app.hapi.protocol.chat.CliOutputBlock
import app.hapi.protocol.chat.CodexReviewBlock
import app.hapi.protocol.chat.GeneratedImageBlock
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock
import coil.ImageLoader

/**
 * Hub-scoped media plumbing for chat blocks: the authed Coil loader plus the
 * generated-image URL builder (both from `HubGraph`). Null loader (previews,
 * tests) degrades to a filename placeholder.
 */
data class ChatMedia(
    val imageLoader: ImageLoader?,
    val generatedImageUrl: (imageId: String) -> String?,
)

val LocalChatMedia = staticCompositionLocalOf { ChatMedia(imageLoader = null) { null } }

/** Stable LazyColumn key. */
val VisibleChatBlock.stableId: String
    get() = when (this) {
        is ChatBlock -> id
        is ToolGroupBlock -> id
    }

/** LazyColumn contentType (recycling bucket). */
val VisibleChatBlock.contentKind: String
    get() = when (this) {
        is ChatBlock -> kind
        is ToolGroupBlock -> kind
    }

/**
 * One thread entry: dispatches a reduced [VisibleChatBlock] to its card —
 * the Compose analogue of the web's block-kind → component mapping
 * (`HappyThread` user/assistant/system messages + `ToolCard`/`ToolGroupCard`).
 * Also used recursively for tool-call children (sidechains).
 */
@Composable
fun ChatBlockCard(
    block: VisibleChatBlock,
    basePath: String?,
    modifier: Modifier = Modifier,
) {
    when (block) {
        is UserTextBlock -> UserTextBlockView(block, modifier)
        is AgentTextBlock -> AgentTextBlockView(block, modifier)
        is AgentReasoningBlock -> AgentReasoningBlockView(block, modifier)
        is AgentEventBlock -> AgentEventBlockView(block, modifier)
        is CliOutputBlock -> CliOutputBlockView(block, modifier)
        is GeneratedImageBlock -> GeneratedImageBlockView(block, modifier)
        is CodexReviewBlock -> CodexReviewBlockView(block, modifier)
        is ToolCallBlock -> ToolCallBlockView(block, basePath, modifier)
        is ToolGroupBlock -> ToolGroupBlockView(block, basePath, modifier)
    }
}

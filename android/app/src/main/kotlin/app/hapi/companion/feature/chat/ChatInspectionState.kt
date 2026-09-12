package app.hapi.companion.feature.chat

import androidx.compose.runtime.staticCompositionLocalOf
import app.hapi.companion.feature.chat.blocks.isPlanProposalTool
import app.hapi.protocol.chat.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal data class Inspected<T>(val value: T, val stale: Boolean)

/** Screen-owned selection snapshots. Recycled rows never own an inspector or a payload Bundle. */
internal class ChatInspectionState {
    private var tools = emptyMap<String, ToolCallBlock>()
    private var groups = emptyMap<String, ToolGroupBlock>()
    private var messages = emptyMap<String, UserTextBlock>()
    private val savedTools = mutableMapOf<String, ToolCallBlock>()
    private val savedGroups = mutableMapOf<String, ToolGroupBlock>()
    private val savedMessages = mutableMapOf<String, UserTextBlock>()
    private var epoch: Long? = null
    private val mutableRevision = MutableStateFlow(0L)
    val revision = mutableRevision.asStateFlow()
    private val mutableReset = MutableStateFlow(0L)
    val reset = mutableReset.asStateFlow()

    @Synchronized fun update(blocks: List<VisibleChatBlock>, epoch: Long? = null) {
        // Reset and publication share the pipeline's ordering: a UI observer
        // cannot clear maps just after the new epoch has been published.
        if (epoch != null) {
            if (this.epoch != null && this.epoch != epoch) invalidate()
            this.epoch = epoch
        }
        val nextTools = mutableMapOf<String, ToolCallBlock>()
        val nextGroups = mutableMapOf<String, ToolGroupBlock>()
        val nextMessages = mutableMapOf<String, UserTextBlock>()
        fun collect(block: VisibleChatBlock) {
            when (block) {
                is ToolCallBlock -> { nextTools[block.id] = block; block.children.forEach(::collect) }
                is ToolGroupBlock -> { nextGroups[block.id] = block; block.tools.forEach(::collect) }
                is UserTextBlock -> nextMessages[block.id] = block
                else -> Unit
            }
        }
        blocks.forEach(::collect)
        tools = nextTools
        groups = nextGroups
        messages = nextMessages
        savedTools.keys.toList().forEach { id -> tools[id]?.let { savedTools[id] = it } }
        savedMessages.keys.toList().forEach { id -> messages[id]?.let { savedMessages[id] = it } }
        savedGroups.keys.toList().forEach { id ->
            // A missing group keeps its membership, including during regrouping.
            val group = groups[id] ?: savedGroups.getValue(id)
            savedGroups[id] = group.withTools(group.tools.map { tools[it.id] ?: it })
        }
        mutableRevision.value++
    }

    @Synchronized fun tool(id: String): Inspected<ToolCallBlock>? {
        val live = tools[id]
        val value = live ?: savedTools[id] ?: savedGroups.values.firstNotNullOfOrNull { group -> group.tools.find { it.id == id } }
        return value?.let { Inspected(it, live == null) }
    }

    @Synchronized fun group(id: String): Inspected<ToolGroupBlock>? =
        (groups[id] ?: savedGroups[id])?.let { Inspected(it, id !in groups) }

    @Synchronized fun message(id: String): Inspected<UserTextBlock>? =
        (messages[id] ?: savedMessages[id])?.let { Inspected(it, id !in messages) }

    @Synchronized fun retainTool(id: String) { tool(id)?.value?.let { savedTools[id] = it } }
    @Synchronized fun retainGroup(id: String) { group(id)?.value?.let { savedGroups[id] = it } }
    @Synchronized fun retainMessage(id: String) { message(id)?.value?.let { savedMessages[id] = it } }

    @Synchronized fun clearSelections() {
        savedTools.clear(); savedGroups.clear(); savedMessages.clear()
    }

    @Synchronized fun invalidate() {
        clearSelections()
        tools = emptyMap(); groups = emptyMap(); messages = emptyMap()
        epoch = null
        mutableReset.value++
        mutableRevision.value++
    }
}

internal fun opensToolProcess(block: ToolCallBlock): Boolean =
    block.children.isNotEmpty() || isSubagentToolName(block.tool.name) || block.tool.name == "CodexAgent"

internal interface ChatInspectionActions {
    fun openTool(id: String)
    fun openGroup(id: String)
    fun openMessage(id: String)
}

internal val LocalChatInspection = staticCompositionLocalOf<ChatInspectionActions?> { null }

/** Protocol grouping remains authoritative. Only the conversation presentation omits payloads. */
internal class TranscriptProjection {
    private data class Entry(val key: Any, val block: VisibleChatBlock)
    private data class GroupKey(val summary: ToolGroupSummary, val activity: String?, val history: String)
    private var previous = emptyMap<String, Entry>()

    // Inline plan bodies need live diagnostics and the complete raw result.
    private fun toolForTranscript(tool: ChatToolCall): ChatToolCall =
        if (isPlanProposalTool(tool.name)) tool else tool.copy(result = null)

    fun project(blocks: List<VisibleChatBlock>): List<VisibleChatBlock> {
        val next = mutableMapOf<String, Entry>()
        val result = blocks.map { block ->
            val key = when (block) {
                is ToolGroupBlock -> GroupKey(block.summary, block.activityTitle, block.historyState)
                is ToolCallBlock -> toolForTranscript(block.tool)
                else -> block
            }
            val retained = previous[block.stableId]?.takeIf { it.key == key }
            val entry = retained ?: Entry(key, when (block) {
                is ToolGroupBlock -> block.withTools(emptyList())
                is ToolCallBlock -> ToolCallBlock(block.id, block.localId, block.createdAt, block.invokedAt,
                    durationMs = block.durationMs, usage = block.usage, model = block.model,
                    tool = toolForTranscript(block.tool), children = emptyList(), meta = block.meta)
                else -> block
            })
            next[block.stableId] = entry
            entry.block
        }
        previous = next
        return result
    }
}

private fun ToolGroupBlock.withTools(members: List<ToolCallBlock>) = ToolGroupBlock(
    id, createdAt, invokedAt, firstToolId, lastToolId, members, defaultOpen,
    historyState, needsOlderHistory, activityTitle, presentationMode, summary,
)

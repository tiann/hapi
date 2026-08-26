package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Port of `web/src/chat/toolGroups.ts` — the visible-layer tool grouping. */

enum class ToolGroupActionKind { READ, SEARCH, COMMAND, MUTATION, WEB, OTHER }

data class ToolGroupSummary(
    val totalTools: Int,
    val countsByKind: Map<ToolGroupActionKind, Int>,
    val fileTargets: List<String>,
    val commandTargets: List<String>,
    val searchTargets: List<String>,
    val urlTargets: List<String>,
    val otherTargets: List<String>,
    val errorCount: Int,
    val runningCount: Int,
    val pendingCount: Int,
)

class ToolGroupBlock(
    val id: String,
    val createdAt: Long,
    val invokedAt: Long?,
    val firstToolId: String,
    val lastToolId: String,
    val tools: List<ToolCallBlock>,
    val defaultOpen: Boolean,
    /** `'complete' | 'needs-older-history'`. */
    val historyState: String,
    val needsOlderHistory: Boolean,
    val activityTitle: String?,
    /** `'default' | 'codex-exploration'`. */
    val presentationMode: String,
    val summary: ToolGroupSummary,
) : VisibleChatBlock {
    val kind: String get() = "tool-group"
}

data class ToolGroupingOptions(
    val hasMoreMessages: Boolean,
    val previousGroups: List<ToolGroupBlock> = emptyList(),
    val codexExplorationCollapsed: Boolean? = null,
)

/** The role a block renders under in the thread. */
fun visibleBlockRole(block: VisibleChatBlock): String = when {
    block is UserTextBlock -> "user"
    block is AgentEventBlock -> "system"
    block is CliOutputBlock -> if (block.source == "user") "user" else "assistant"
    else -> "assistant"
}

private val PLAN_TOOL_NAMES = setOf(
    "TodoWrite",
    "update_plan",
    "ExitPlanMode",
    "exit_plan_mode",
    "CodexReasoning",
)

private val MILESTONE_TOOL_NAMES = setOf(
    "Task",
    "Agent",
    "CodexAgent",
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    "AgyTaskLog",
    "Skill",
    "spawn_agent",
    "send_input",
    "send_message",
    "resume_agent",
    "followup_task",
    "wait_agent",
    "close_agent",
    "interrupt_agent",
    "list_agents",
)

private val INTERACTIVE_TOOL_NAMES = setOf(
    "CodexPermission",
)

private fun pushUnique(target: MutableList<String>, value: String?) {
    if (value.isNullOrEmpty()) return
    if (target.contains(value)) return
    target.add(value)
}

private fun normalizeCommandInput(input: JsonElement?): String? {
    val direct = getInputStringAny(input, listOf("command", "cmd"))
    if (direct != null) return direct

    val record = asObject(input) ?: return null
    val command = record["command"] as? JsonArray ?: return null

    val parts = command.mapNotNull { part ->
        (part as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
    }
    return if (parts.isNotEmpty()) parts.joinToString(" ") else null
}

fun getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    val name = block.tool.name

    if (name == "Read" || name == "NotebookRead") return ToolGroupActionKind.READ
    if (name == "Grep" || name == "Glob" || name == "LS") return ToolGroupActionKind.SEARCH
    if (name == "Bash" || name == "CodexBash" || name == "shell_command" || name == "run_shell_command") {
        return ToolGroupActionKind.COMMAND
    }
    if (name == "Edit" || name == "MultiEdit" || name == "Write" || name == "NotebookEdit"
        || name == "CodexPatch" || name == "CodexDiff"
    ) {
        return ToolGroupActionKind.MUTATION
    }
    if (name == "WebFetch" || name == "WebSearch") return ToolGroupActionKind.WEB
    return ToolGroupActionKind.OTHER
}

private fun getPrimaryFileTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("file_path", "path", "file", "filePath", "notebook_path", "name"))

private fun getPrimarySearchTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("pattern", "query"))

private fun getPrimaryUrlTarget(block: ToolCallBlock): String? =
    getInputStringAny(block.tool.input, listOf("url"))

private fun getPrimaryOtherTarget(block: ToolCallBlock): String? {
    getPrimaryFileTarget(block)?.let { return it }
    getPrimarySearchTarget(block)?.let { return it }
    normalizeCommandInput(block.tool.input)?.let { return it }
    getPrimaryUrlTarget(block)?.let { return it }
    return block.tool.name
}

private fun summarizeToolGroup(tools: List<ToolCallBlock>): ToolGroupSummary {
    val countsByKind = linkedMapOf(
        ToolGroupActionKind.READ to 0,
        ToolGroupActionKind.SEARCH to 0,
        ToolGroupActionKind.COMMAND to 0,
        ToolGroupActionKind.MUTATION to 0,
        ToolGroupActionKind.WEB to 0,
        ToolGroupActionKind.OTHER to 0,
    )
    val fileTargets = mutableListOf<String>()
    val commandTargets = mutableListOf<String>()
    val searchTargets = mutableListOf<String>()
    val urlTargets = mutableListOf<String>()
    val otherTargets = mutableListOf<String>()
    var errorCount = 0
    var runningCount = 0
    var pendingCount = 0

    for (tool in tools) {
        val kind = getToolGroupActionKind(tool)
        countsByKind[kind] = (countsByKind[kind] ?: 0) + 1

        when (tool.tool.state) {
            ToolState.ERROR -> errorCount += 1
            ToolState.RUNNING -> runningCount += 1
            ToolState.PENDING -> pendingCount += 1
        }

        when (kind) {
            ToolGroupActionKind.READ, ToolGroupActionKind.MUTATION -> pushUnique(fileTargets, getPrimaryFileTarget(tool))
            ToolGroupActionKind.SEARCH -> pushUnique(searchTargets, getPrimarySearchTarget(tool))
            ToolGroupActionKind.COMMAND -> pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            ToolGroupActionKind.WEB -> pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?: getPrimarySearchTarget(tool))
            ToolGroupActionKind.OTHER -> pushUnique(otherTargets, getPrimaryOtherTarget(tool))
        }
    }

    return ToolGroupSummary(
        totalTools = tools.size,
        countsByKind = countsByKind,
        fileTargets = fileTargets,
        commandTargets = commandTargets,
        searchTargets = searchTargets,
        urlTargets = urlTargets,
        otherTargets = otherTargets,
        errorCount = errorCount,
        runningCount = runningCount,
        pendingCount = pendingCount,
    )
}

private fun isInteractiveToolBlock(block: ToolCallBlock): Boolean =
    INTERACTIVE_TOOL_NAMES.contains(block.tool.name)
        || block.tool.permission?.status == "pending"
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)

fun isEligibleForToolGrouping(block: ToolCallBlock): Boolean {
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.contains(block.tool.name)) return false
    if (MILESTONE_TOOL_NAMES.contains(block.tool.name)) return false
    if (isInteractiveToolBlock(block)) return false
    if (block.tool.name == "CodexBash" && getCodexCommandActions(block).isNotEmpty()) {
        return isCodexExplorationTool(block)
    }
    return true
}

private fun getGroupingFamily(block: ToolCallBlock): String? {
    if (!isEligibleForToolGrouping(block)) return null
    return if (isCodexExplorationTool(block)) "codex-exploration" else "default"
}

private fun createToolGroupId(
    tools: List<ToolCallBlock>,
    needsOlderHistory: Boolean,
    previousGroups: List<ToolGroupBlock>,
): String {
    val firstToolId = tools.firstOrNull()?.id ?: "unknown"
    val lastToolId = tools.lastOrNull()?.id ?: firstToolId

    val previous = previousGroups.firstOrNull { it.firstToolId == firstToolId || it.lastToolId == lastToolId }
    if (previous != null) {
        return previous.id
    }

    return if (needsOlderHistory) "tool-group:$lastToolId" else "tool-group:$firstToolId"
}

fun isToolGroupBlock(block: VisibleChatBlock): Boolean = block is ToolGroupBlock

fun buildVisibleChatBlocks(
    blocks: List<ChatBlock>,
    options: ToolGroupingOptions,
): List<VisibleChatBlock> {
    val visibleBlocks = mutableListOf<VisibleChatBlock>()
    val previousGroups = options.previousGroups

    var index = 0
    while (index < blocks.size) {
        val block = blocks[index]
        if (block !is ToolCallBlock) {
            visibleBlocks.add(block)
            index += 1
            continue
        }
        val groupingFamily = getGroupingFamily(block)
        if (groupingFamily == null) {
            visibleBlocks.add(block)
            index += 1
            continue
        }

        val tools = mutableListOf(block)
        var cursor = index + 1
        while (cursor < blocks.size) {
            val candidate = blocks[cursor]
            if (candidate !is ToolCallBlock || getGroupingFamily(candidate) != groupingFamily) {
                break
            }
            tools.add(candidate)
            cursor += 1
        }

        if (tools.size < 2 && groupingFamily != "codex-exploration") {
            visibleBlocks.add(block)
            index += 1
            continue
        }

        val startsAtOldestVisibleBoundary = visibleBlocks.isEmpty()
        val needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        val previousBlock = visibleBlocks.lastOrNull()
        val activityTitle = if (previousBlock is ToolCallBlock && previousBlock.tool.name == "CodexReasoning") {
            getInputStringAny(previousBlock.tool.input, listOf("title"))
        } else {
            null
        }
        visibleBlocks.add(
            ToolGroupBlock(
                id = createToolGroupId(tools, needsOlderHistory, previousGroups),
                createdAt = tools.first().createdAt,
                invokedAt = tools.first().invokedAt,
                firstToolId = tools.first().id,
                lastToolId = tools.last().id,
                tools = tools,
                defaultOpen = groupingFamily == "codex-exploration" && options.codexExplorationCollapsed == false,
                historyState = if (needsOlderHistory) "needs-older-history" else "complete",
                needsOlderHistory = needsOlderHistory,
                activityTitle = activityTitle,
                presentationMode = groupingFamily,
                summary = summarizeToolGroup(tools),
            )
        )
        index = cursor
    }

    return visibleBlocks
}

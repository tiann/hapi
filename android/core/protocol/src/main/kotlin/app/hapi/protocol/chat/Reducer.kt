package app.hapi.protocol.chat

import app.hapi.protocol.wire.AgentState

/** Port of `web/src/chat/reducer.ts` — the `reduceChatBlocks` orchestration. */

private fun calculateContextSize(usage: UsageData): Double {
    usage.contextTokens?.let { return it }
    // TS `(a || 0) + (b || 0) + input` — || collapses 0/NaN identically for numbers.
    return (usage.cacheCreationInputTokens ?: 0.0) + (usage.cacheReadInputTokens ?: 0.0) + usage.inputTokens
}

/** Whether a message's usage describes the parent thread's context (sidechains never do). */
private fun isUsageVisibleInParentContext(msg: NormalizedMessage): Boolean {
    if (msg.isSidechain) return false
    return msg.usage?.scopeRole != "child"
}

data class LatestUsage(
    val inputTokens: Double,
    val outputTokens: Double,
    val cacheCreation: Double,
    val cacheRead: Double,
    val contextSize: Double,
    val contextWindow: Double?,
    val model: String?,
    val timestamp: Long,
)

data class ReduceChatBlocksResult(
    val blocks: List<ChatBlock>,
    val hasReadyEvent: Boolean,
    val latestUsage: LatestUsage?,
    /** Latest thread goal (raw normalized goal object), advisory — not in fixtures. */
    val latestGoal: kotlinx.serialization.json.JsonObject?,
)

private val GOAL_COMMAND_REGEX = Regex("^\\s*/goal(?:\\s|$)", RegexOption.IGNORE_CASE)

private fun getLatestThreadGoal(normalized: List<NormalizedMessage>): kotlinx.serialization.json.JsonObject? {
    var sawNewerNonGoalUserMessage = false
    for (i in normalized.indices.reversed()) {
        val msg = normalized[i]
        if (msg is NormalizedMessage.User) {
            if (!GOAL_COMMAND_REGEX.containsMatchIn(msg.text)) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        val event = (msg as? NormalizedMessage.Event)?.event ?: continue
        if (event.type == "thread-goal-cleared") return null
        if (event.type == "thread-goal-updated") {
            val goal = asObject(event.raw["goal"])
            if (goal != null && asString(goal["status"]) == "complete" && sawNewerNonGoalUserMessage) {
                return null
            }
            return goal
        }
    }
    return null
}

private fun isRedundantGoalStatusMessage(event: AgentEvent): Boolean {
    if (event.type != "message") return false
    return isRedundantGoalStatusMessageText(asString(event.raw["message"]))
}

private fun isSilentGoalEventBlock(block: ChatBlock): Boolean {
    if (block !is AgentEventBlock) return false
    return block.event.type == "thread-goal-updated"
        || block.event.type == "thread-goal-cleared"
        || isRedundantGoalStatusMessage(block.event)
}

private fun filterSilentGoalBlocks(blocks: List<ChatBlock>): List<ChatBlock> {
    val filtered = mutableListOf<ChatBlock>()

    for (block in blocks) {
        if (isSilentGoalEventBlock(block)) continue
        if (block is ToolCallBlock && block.children.isNotEmpty()) {
            block.children = filterSilentGoalBlocks(block.children)
            filtered.add(block)
            continue
        }
        filtered.add(block)
    }

    return filtered
}

fun reduceChatBlocks(
    normalized: List<NormalizedMessage>,
    agentState: AgentState?,
    goalStateMessages: List<NormalizedMessage>? = null,
    /** TS `Date.now()` for a pending request missing `createdAt`; injectable for determinism. */
    now: () -> Long = { System.currentTimeMillis() },
): ReduceChatBlocksResult {
    val permissionsById = getPermissions(agentState)
    val toolIdsInMessages = collectToolIdsFromMessages(normalized)
    val titleChangesByToolUseId = collectTitleChanges(normalized)

    val traced = traceMessages(normalized)
    val groups = LinkedHashMap<String, MutableList<NormalizedMessage>>()
    val root = mutableListOf<NormalizedMessage>()

    for (msg in traced) {
        val sidechainId = msg.sidechainId
        if (sidechainId != null) {
            groups.getOrPut(sidechainId) { mutableListOf() }.add(msg.message)
        } else {
            root.add(msg.message)
        }
    }

    val reducerContext = ReduceContext(
        permissionsById = permissionsById,
        groups = groups,
        consumedGroupIds = mutableSetOf(),
        titleChangesByToolUseId = titleChangesByToolUseId,
        emittedTitleChangeToolUseIds = mutableSetOf(),
    )
    val rootResult = reduceTimeline(root, reducerContext)
    val hasReadyEvent = rootResult.hasReadyEvent

    // Synthesize a tool card only for a *pending* permission that has no tool
    // call/result in the transcript — and never one older than the oldest
    // message in the current window (it would mis-sort against newer messages).
    val oldestMessageTime: Long? = normalized.minOfOrNull { it.createdAt }

    for ((id, entry) in permissionsById) {
        if (entry.permission.status != "pending") continue
        if (toolIdsInMessages.contains(id)) continue
        if (rootResult.toolBlocksById.containsKey(id)) continue

        val createdAt = entry.permission.createdAt ?: now()

        if (oldestMessageTime != null && createdAt < oldestMessageTime) {
            continue
        }

        ensureToolBlock(
            rootResult.blocks, rootResult.toolBlocksById, id,
            ToolBlockSeed(
                createdAt = createdAt,
                localId = null,
                name = entry.toolName,
                input = entry.input,
                description = null,
                permission = entry.permission,
            )
        )
    }

    // Latest usage: most recent message with parent-context usage data.
    var latestUsage: LatestUsage? = null
    for (i in normalized.indices.reversed()) {
        val msg = normalized[i]
        val usage = msg.usage
        if (usage != null && isUsageVisibleInParentContext(msg)) {
            latestUsage = LatestUsage(
                inputTokens = usage.inputTokens,
                outputTokens = usage.outputTokens,
                cacheCreation = usage.cacheCreationInputTokens ?: 0.0,
                cacheRead = usage.cacheReadInputTokens ?: 0.0,
                contextSize = calculateContextSize(usage),
                contextWindow = usage.contextWindow,
                model = msg.model,
                timestamp = msg.createdAt,
            )
            break
        }
    }

    return ReduceChatBlocksResult(
        blocks = filterSilentGoalBlocks(dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks))),
        hasReadyEvent = hasReadyEvent,
        latestUsage = latestUsage,
        latestGoal = getLatestThreadGoal(goalStateMessages ?: normalized),
    )
}

package app.hapi.protocol.chat

import app.hapi.protocol.wire.AgentState
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/** Port of `web/src/chat/reducerTools.ts`. */

data class PermissionEntry(
    val toolName: String,
    /** Verbatim `arguments` (wire default [JsonNull] when absent — projected as `input: null`, like TS `?? null`). */
    val input: JsonElement,
    val permission: ToolPermission,
)

fun getPermissions(agentState: AgentState?): LinkedHashMap<String, PermissionEntry> {
    val map = LinkedHashMap<String, PermissionEntry>()

    val completed = agentState?.completedRequests
    if (completed != null) {
        for ((id, entry) in completed) {
            map[id] = PermissionEntry(
                toolName = entry.tool,
                input = entry.arguments,
                permission = ToolPermission(
                    id = id,
                    status = entry.status,
                    reason = entry.reason,
                    mode = entry.mode,
                    decision = entry.decision,
                    allowedTools = entry.allowTools,
                    answers = entry.answers,
                    createdAt = entry.createdAt,
                    completedAt = entry.completedAt,
                    presence = ToolPermission.COMPLETED_KEYS,
                ),
            )
        }
    }

    val requests = agentState?.requests
    if (requests != null) {
        for ((id, request) in requests) {
            if (map.containsKey(id)) continue
            map[id] = PermissionEntry(
                toolName = request.tool,
                input = request.arguments,
                permission = ToolPermission(
                    id = id,
                    status = "pending",
                    createdAt = request.createdAt,
                    presence = ToolPermission.PENDING_KEYS,
                ),
            )
        }
    }

    return map
}

/** Mutable seed for [ensureToolBlock]; Kotlin null mirrors TS `undefined` throughout. */
class ToolBlockSeed(
    val createdAt: Long,
    val invokedAt: Long? = null,
    val durationMs: Double? = null,
    val usage: UsageData? = null,
    val model: String? = null,
    val localId: String? = null,
    val meta: JsonElement? = null,
    val name: String,
    val input: JsonElement? = null,
    val description: String? = null,
    val nativeTitle: String? = null,
    val nativeKind: String? = null,
    /** Tri-state (TS `progress?: unknown` with an `'in' data` guard at the call site). */
    val hasProgress: Boolean = false,
    val progress: JsonElement? = null,
    val permission: ToolPermission? = null,
    val agentTimestamp: Long? = null,
)

private fun isPlaceholderToolName(name: String): Boolean {
    val normalized = name.trim().lowercase()
    return normalized == "" || normalized == "tool" || normalized == "unknown" || normalized == "generic"
}

fun ensureToolBlock(
    blocks: MutableList<ChatBlock>,
    toolBlocksById: MutableMap<String, ToolCallBlock>,
    id: String,
    seed: ToolBlockSeed,
): ToolCallBlock {
    val existing = toolBlocksById[id]
    if (existing != null) {
        // Preserve earliest createdAt for stable ordering.
        if (seed.createdAt < existing.createdAt) {
            existing.createdAt = seed.createdAt
            existing.tool = existing.tool.copy(createdAt = seed.createdAt)
        }
        if (seed.permission != null) {
            val nextPermission = existing.tool.permission?.mergedWith(seed.permission) ?: seed.permission
            var nextState = existing.tool.state
            if (existing.tool.state == ToolState.RUNNING && seed.permission.status == "pending") {
                nextState = ToolState.PENDING
            }
            existing.tool = existing.tool.copy(permission = nextPermission, state = nextState)
        }
        if (seed.name.isNotEmpty() && (!isPlaceholderToolName(seed.name) || isPlaceholderToolName(existing.tool.name))) {
            existing.tool = existing.tool.copy(name = seed.name)
        }
        if (seed.input != null && seed.input != JsonNull) {
            existing.tool = existing.tool.copy(input = seed.input)
        }
        if (seed.description != null) {
            existing.tool = existing.tool.copy(description = seed.description)
        }
        if (seed.nativeTitle != null) {
            existing.tool = existing.tool.copy(nativeTitle = seed.nativeTitle)
        }
        if (seed.nativeKind != null) {
            existing.tool = existing.tool.copy(nativeKind = seed.nativeKind)
        }
        if (seed.hasProgress && existing.tool.state == ToolState.RUNNING) {
            existing.tool = existing.tool.copy(result = seed.progress ?: JsonNull)
        }
        // tool_use records the invocation time; the tool_result's invokedAt is
        // when the result was processed — keep the original.
        if (seed.invokedAt != null && existing.invokedAt == null) {
            existing.invokedAt = seed.invokedAt
        }
        if (seed.durationMs != null) {
            existing.durationMs = seed.durationMs
        }
        if (seed.usage != null) {
            existing.usage = seed.usage
        }
        if (seed.model != null) {
            existing.model = seed.model
        }
        return existing
    }

    val initialState = when {
        seed.permission?.status == "pending" -> ToolState.PENDING
        seed.permission?.status == "denied" || seed.permission?.status == "canceled" -> ToolState.ERROR
        else -> ToolState.RUNNING
    }

    val tool = ChatToolCall(
        id = id,
        name = seed.name,
        state = initialState,
        input = seed.input,
        createdAt = seed.createdAt,
        startedAt = if (initialState == ToolState.RUNNING) seed.createdAt.toDouble() else null,
        completedAt = null,
        // Exec start only ever comes from a real Claude entry timestamp.
        execStartedAt = if (initialState == ToolState.RUNNING) seed.agentTimestamp?.toDouble() else null,
        execCompletedAt = null,
        description = seed.description,
        nativeTitle = seed.nativeTitle,
        nativeKind = seed.nativeKind,
        result = if (seed.hasProgress) seed.progress ?: JsonNull else null,
        permission = seed.permission,
    )

    val block = ToolCallBlock(
        id = id,
        localId = seed.localId,
        createdAt = seed.createdAt,
        invokedAt = seed.invokedAt,
        durationMs = seed.durationMs,
        usage = seed.usage,
        model = seed.model,
        tool = tool,
        children = emptyList(),
        meta = seed.meta,
    )

    toolBlocksById[id] = block
    blocks.add(block)
    return block
}

fun collectToolIdsFromMessages(messages: List<NormalizedMessage>): Set<String> {
    val ids = mutableSetOf<String>()
    for (msg in messages) {
        val agent = msg as? NormalizedMessage.Agent ?: continue
        for (content in agent.content) {
            when (content) {
                is NormalizedAgentContent.ToolUse -> ids.add(content.id)
                is NormalizedAgentContent.ToolResult -> ids.add(content.toolUseId)
                else -> {}
            }
        }
    }
    return ids
}

fun isChangeTitleToolName(name: String): Boolean =
    name == "mcp__hapi__change_title" || name == "hapi__change_title"

fun extractTitleFromChangeTitleInput(input: JsonElement?): String? {
    val title = asObject(input)?.let { asString(it["title"]) } ?: return null
    return title.trim().takeIf { it.isNotEmpty() }
}

fun collectTitleChanges(messages: List<NormalizedMessage>): Map<String, String> {
    val map = HashMap<String, String>()
    for (msg in messages) {
        val agent = msg as? NormalizedMessage.Agent ?: continue
        for (content in agent.content) {
            val toolUse = content as? NormalizedAgentContent.ToolUse ?: continue
            if (!isChangeTitleToolName(toolUse.name)) continue
            val title = extractTitleFromChangeTitleInput(toolUse.input) ?: continue
            map[toolUse.id] = title
        }
    }
    return map
}

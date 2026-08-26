package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Port of `web/src/chat/reducerTimeline.ts` — tool pairing, stream coalescing, agent-run cards. */

class ReduceContext(
    val permissionsById: Map<String, PermissionEntry>,
    val groups: Map<String, List<NormalizedMessage>>,
    val consumedGroupIds: MutableSet<String>,
    val titleChangesByToolUseId: Map<String, String>,
    val emittedTitleChangeToolUseIds: MutableSet<String>,
)

class TimelineResult(
    val blocks: MutableList<ChatBlock>,
    val toolBlocksById: MutableMap<String, ToolCallBlock>,
    val hasReadyEvent: Boolean,
)

private fun getEventString(event: JsonObject, key: String): String? = asString(event[key])

private fun getEventNumber(event: JsonObject, key: String): Double? = asNumber(event[key])

private fun getAgentRunStartedAt(event: JsonObject): Double? =
    getEventNumber(event, "startedAt") ?: getEventNumber(event, "started_at")

private fun getAgentRunCompletedAt(event: JsonObject): Double? =
    getEventNumber(event, "completedAt") ?: getEventNumber(event, "completed_at")

private fun setEarliestStartedAt(block: ToolCallBlock, startedAt: Double?) {
    if (startedAt == null) return
    val nextStartedAt = block.tool.startedAt?.let { minOf(it, startedAt) } ?: startedAt
    if (nextStartedAt != block.tool.startedAt) {
        block.tool = block.tool.copy(startedAt = nextStartedAt)
    }
}

private fun setEarliestExecStartedAt(block: ToolCallBlock, execStartedAt: Double?) {
    if (execStartedAt == null) return
    val nextExecStartedAt = block.tool.execStartedAt?.let { minOf(it, execStartedAt) } ?: execStartedAt
    if (nextExecStartedAt != block.tool.execStartedAt) {
        block.tool = block.tool.copy(execStartedAt = nextExecStartedAt)
    }
}

private fun getAgentRunCardId(event: JsonObject, fallback: String): String =
    getEventString(event, "cardId") ?: getEventString(event, "card_id") ?: fallback

private fun isFallbackAgentRunCardId(cardId: String, agentId: String?): Boolean =
    agentId != null && cardId == "codex-agent:$agentId"

private fun mapAgentRunStatusToToolState(status: String?): String = when (status) {
    "completed" -> ToolState.COMPLETED
    "failed", "error", "canceled", "cancelled", "notFound", "not_found" -> ToolState.ERROR
    "pending" -> ToolState.PENDING
    else -> ToolState.RUNNING
}

private fun isTerminalAgentRunState(state: String): Boolean =
    state == ToolState.COMPLETED || state == ToolState.ERROR

private fun isNonTerminalAgentRunState(state: String): Boolean =
    state == ToolState.RUNNING || state == ToolState.PENDING

private fun shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(
    block: ToolCallBlock,
    nextState: String,
    event: JsonObject,
): Boolean {
    if (!isTerminalAgentRunState(block.tool.state)) return false
    if (!isNonTerminalAgentRunState(nextState)) return false

    val activityKind = getEventString(event, "activityKind") ?: getEventString(event, "activity_kind")
    return activityKind == "wait_agent" || activityKind == "close_agent"
}

private fun isCloseAgentCleanupUpdate(event: JsonObject): Boolean {
    val activityKind = getEventString(event, "activityKind") ?: getEventString(event, "activity_kind")
    if (activityKind == "close_agent" || activityKind == "closed") return true

    val activity = getEventString(event, "activity")
    val statusText = getEventString(event, "statusText") ?: getEventString(event, "status_text")
    if (activityKind != "canceled" || (activity != "Closed" && statusText != "Closed")) return false

    val result = asObject(event["result"]) ?: return false
    return asObject(result["previous_status"]) != null || asObject(result["previousStatus"]) != null
}

private fun shouldIgnoreAgentRunCloseCleanupAfterTerminal(
    block: ToolCallBlock,
    status: String?,
    event: JsonObject,
): Boolean {
    if (!isTerminalAgentRunState(block.tool.state)) return false
    if (status == "failed" || status == "error") return false
    return isCloseAgentCleanupUpdate(event)
}

private fun getAgentRunDisplayPatch(event: JsonObject): LinkedHashMap<String, JsonElement> {
    val patch = LinkedHashMap<String, JsonElement>()
    val summary = getEventString(event, "summary")
    val activity = getEventString(event, "activity")
    val activityKind = getEventString(event, "activityKind") ?: getEventString(event, "activity_kind")

    if (!summary.isNullOrEmpty()) patch["summary"] = JsonPrimitive(summary)
    if (!activity.isNullOrEmpty()) patch["activity"] = JsonPrimitive(activity)
    if (!activityKind.isNullOrEmpty()) patch["activityKind"] = JsonPrimitive(activityKind)

    return patch
}

private val WHITESPACE_RUN_REGEX = Regex("\\s+")

private fun getAgentRunFingerprint(event: JsonObject): String? {
    val summary = getEventString(event, "summary")
    if (!summary.isNullOrEmpty()) return summary

    val input = asObject(event["input"])
    val direct = input?.let { asString(it["message"]) ?: asString(it["prompt"]) }
    if (!direct.isNullOrEmpty()) return direct.replace(WHITESPACE_RUN_REGEX, " ").trim()

    val items = input?.get("items") as? kotlinx.serialization.json.JsonArray
    if (items != null) {
        val text = items
            .mapNotNull { item -> asObject(item)?.let { asString(it["text"]) } }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
            .replace(WHITESPACE_RUN_REGEX, " ")
            .trim()
        return text.takeIf { it.isNotEmpty() }
    }

    return null
}

private fun isAgentNotFoundUpdate(event: JsonObject): Boolean {
    val status = getEventString(event, "status")
    val activityKind = getEventString(event, "activityKind") ?: getEventString(event, "activity_kind")
    return status == "notFound" || status == "not_found" || activityKind == "not_found"
}

private fun isAgentToolOnlyUpdate(event: JsonObject): Boolean {
    val activityKind = getEventString(event, "activityKind") ?: getEventString(event, "activity_kind")
    return activityKind == "wait_agent"
        || activityKind == "send_input"
        || activityKind == "resume_agent"
        || activityKind == "close_agent"
        || isAgentNotFoundUpdate(event)
}

private fun isOrphanAgentRunBlock(block: ToolCallBlock): Boolean {
    if (block.children.isNotEmpty()) return false
    if (block.tool.result != null) return false
    if (block.tool.state == ToolState.COMPLETED || block.tool.state == ToolState.ERROR) return false
    val input = asObject(block.tool.input)
    if (input != null && (!asString(input["agentId"]).isNullOrEmpty() || !asString(input["agent_id"]).isNullOrEmpty())) {
        return false
    }
    return true
}

private fun prefixAgentTraceId(agentId: String, kind: String, id: String): String {
    val prefix = "codex-agent:$agentId:"
    return if (id.startsWith(prefix)) id else "$prefix$kind:$id"
}

private fun normalizeTraceMessage(
    agentId: String,
    message: JsonElement?,
    source: NormalizedMessage,
): List<NormalizedMessage> {
    val data = asObject(message) ?: return emptyList()
    val dataType = asString(data["type"]) ?: return emptyList()

    val traceId = prefixAgentTraceId(agentId, "trace", asString(data["id"]) ?: "${source.id}:trace")
    val createdAt = source.createdAt
    val meta = source.meta

    if (dataType == "error") {
        val text = asString(data["message"])
        if (text != null) {
            return listOf(
                NormalizedMessage.Event(
                    id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                    event = AgentEvent.of(buildJsonObject {
                        put("type", "error")
                        put("message", text)
                    }),
                )
            )
        }
    }

    if (dataType == "message") {
        val text = asString(data["message"])
        if (text != null) {
            return listOf(
                NormalizedMessage.Agent(
                    id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                    content = listOf(NormalizedAgentContent.Text(text = text, uuid = traceId, parentUUID = null)),
                )
            )
        }
    }

    if (dataType == "reasoning") {
        val text = asString(data["message"])
        if (text != null) {
            return listOf(
                NormalizedMessage.Agent(
                    id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                    content = listOf(
                        NormalizedAgentContent.Reasoning(text = text, uuid = traceId, streamId = traceId, parentUUID = null)
                    ),
                )
            )
        }
    }

    if (dataType == "tool-call") {
        val rawCallId = asString(data["callId"])
        if (rawCallId != null) {
            val callId = prefixAgentTraceId(agentId, "call", rawCallId)
            return listOf(
                NormalizedMessage.Agent(
                    id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                    content = listOf(
                        NormalizedAgentContent.ToolUse(
                            id = callId,
                            name = asString(data["name"]) ?: "unknown",
                            input = data["input"],
                            description = null,
                            uuid = traceId,
                            parentUUID = null,
                        )
                    ),
                )
            )
        }
    }

    if (dataType == "tool-call-result") {
        val rawCallId = asString(data["callId"])
        if (rawCallId != null) {
            val callId = prefixAgentTraceId(agentId, "call", rawCallId)
            return listOf(
                NormalizedMessage.Agent(
                    id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                    content = listOf(
                        NormalizedAgentContent.ToolResult(
                            toolUseId = callId,
                            content = if (data.containsKey("output")) data.getValue("output") else null,
                            isError = jsTruthy(data["is_error"]),
                            uuid = traceId,
                            parentUUID = null,
                        )
                    ),
                )
            )
        }
    }

    if (dataType == "token_count") {
        return emptyList()
    }

    if (dataType == "ready" || dataType == "task_complete") {
        return listOf(
            NormalizedMessage.Event(
                id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
                event = AgentEvent.of(buildJsonObject {
                    put("type", "ready")
                    put("agentId", agentId)
                }),
            )
        )
    }

    return listOf(
        NormalizedMessage.Event(
            id = traceId, localId = null, createdAt = createdAt, isSidechain = false, meta = meta,
            event = AgentEvent.of(buildJsonObject {
                put("type", "message")
                put("message", asString(data["statusText"]) ?: asString(data["status"]) ?: dataType)
            }),
        )
    )
}

@Suppress("CyclomaticComplexMethod", "LongMethod")
fun reduceTimeline(
    messages: List<NormalizedMessage>,
    context: ReduceContext,
): TimelineResult {
    val blocks = mutableListOf<ChatBlock>()
    val toolBlocksById = HashMap<String, ToolCallBlock>()
    val agentRunBlocksByCardId = HashMap<String, ToolCallBlock>()
    val agentRunCardByAgentId = LinkedHashMap<String, String>()
    val agentRunTraceMessagesByCardId = HashMap<String, MutableList<NormalizedMessage>>()
    val pendingAgentRunCardByFingerprint = LinkedHashMap<String, String>()
    val textBlocksByStreamId = HashMap<String, AgentTextBlock>()
    val reasoningBlocksByStreamId = HashMap<String, AgentReasoningBlock>()
    var hasReadyEvent = false

    fun ensureAgentRunBlock(
        cardId: String,
        createdAt: Long,
        invokedAt: Long?,
        model: String?,
        localId: String?,
        meta: JsonElement?,
        input: JsonElement?,
    ): ToolCallBlock {
        val block = ensureToolBlock(
            blocks, toolBlocksById, cardId,
            ToolBlockSeed(
                createdAt = createdAt,
                invokedAt = invokedAt,
                model = model,
                localId = localId,
                meta = meta,
                name = "CodexAgent",
                input = input,
                description = null,
            )
        )
        agentRunBlocksByCardId[cardId] = block
        return block
    }

    fun refreshAgentRunChildren(cardId: String) {
        val block = agentRunBlocksByCardId[cardId] ?: return
        val traceMessages = agentRunTraceMessagesByCardId[cardId] ?: emptyList()
        if (traceMessages.isEmpty()) {
            block.children = emptyList()
            return
        }

        val child = reduceTimeline(
            traceMessages,
            ReduceContext(
                permissionsById = context.permissionsById,
                groups = emptyMap(),
                consumedGroupIds = mutableSetOf(),
                titleChangesByToolUseId = collectTitleChanges(traceMessages),
                emittedTitleChangeToolUseIds = mutableSetOf(),
            )
        )
        block.children = child.blocks
    }

    fun patchAgentRunInput(block: ToolCallBlock, patch: Map<String, JsonElement>) {
        val current = asObject(block.tool.input) ?: JsonObject(emptyMap())
        val next = LinkedHashMap<String, JsonElement>(current)
        next.putAll(patch)
        block.tool = block.tool.copy(input = JsonObject(next))
    }

    fun removeAgentRunBlock(cardId: String) {
        val block = agentRunBlocksByCardId[cardId] ?: return
        val index = blocks.indexOfFirst { it === block }
        if (index != -1) {
            blocks.removeAt(index)
        }
        toolBlocksById.remove(cardId)
        agentRunBlocksByCardId.remove(cardId)
        agentRunTraceMessagesByCardId.remove(cardId)
        for ((fingerprint, pendingCardId) in pendingAgentRunCardByFingerprint.toList()) {
            if (pendingCardId == cardId) {
                pendingAgentRunCardByFingerprint.remove(fingerprint)
            }
        }
    }

    fun mergeAgentRunBlock(fromCardId: String, toCardId: String, toBlock: ToolCallBlock) {
        if (fromCardId == toCardId) return

        val fromBlock = agentRunBlocksByCardId[fromCardId] ?: return
        if (fromBlock === toBlock) return

        val fromInput = asObject(fromBlock.tool.input) ?: JsonObject(emptyMap())
        val toInput = asObject(toBlock.tool.input) ?: JsonObject(emptyMap())
        if (fromInput.isNotEmpty() || toInput.isNotEmpty()) {
            val mergedInput = LinkedHashMap<String, JsonElement>(fromInput)
            mergedInput.putAll(toInput)
            toBlock.tool = toBlock.tool.copy(input = JsonObject(mergedInput))
        }

        toBlock.createdAt = minOf(toBlock.createdAt, fromBlock.createdAt)
        toBlock.tool = toBlock.tool.copy(createdAt = minOf(toBlock.tool.createdAt, fromBlock.tool.createdAt))
        fromBlock.tool.startedAt?.let { fromStartedAt ->
            toBlock.tool = toBlock.tool.copy(
                startedAt = toBlock.tool.startedAt?.let { minOf(it, fromStartedAt) } ?: fromStartedAt
            )
        }
        fromBlock.tool.completedAt?.let { fromCompletedAt ->
            toBlock.tool = toBlock.tool.copy(
                completedAt = toBlock.tool.completedAt?.let { maxOf(it, fromCompletedAt) } ?: fromCompletedAt
            )
        }
        fromBlock.tool.execStartedAt?.let { fromExecStartedAt ->
            toBlock.tool = toBlock.tool.copy(
                execStartedAt = toBlock.tool.execStartedAt?.let { minOf(it, fromExecStartedAt) } ?: fromExecStartedAt
            )
        }
        fromBlock.tool.execCompletedAt?.let { fromExecCompletedAt ->
            toBlock.tool = toBlock.tool.copy(
                execCompletedAt = toBlock.tool.execCompletedAt?.let { maxOf(it, fromExecCompletedAt) } ?: fromExecCompletedAt
            )
        }
        toBlock.durationMs = toBlock.durationMs ?: fromBlock.durationMs
        toBlock.usage = toBlock.usage ?: fromBlock.usage
        toBlock.model = toBlock.model ?: fromBlock.model

        if (!isTerminalAgentRunState(toBlock.tool.state) && isTerminalAgentRunState(fromBlock.tool.state)) {
            toBlock.tool = toBlock.tool.copy(state = fromBlock.tool.state)
        }
        if (toBlock.tool.result == null && fromBlock.tool.result != null) {
            toBlock.tool = toBlock.tool.copy(result = fromBlock.tool.result)
        }

        val fromTrace = agentRunTraceMessagesByCardId[fromCardId] ?: mutableListOf()
        val toTrace = agentRunTraceMessagesByCardId[toCardId] ?: mutableListOf()
        if (fromTrace.isNotEmpty() || toTrace.isNotEmpty()) {
            val mergedTrace = (toTrace + fromTrace)
                .sortedWith(compareBy({ it.createdAt }, { it.id }))
                .toMutableList()
            agentRunTraceMessagesByCardId[toCardId] = mergedTrace
            agentRunTraceMessagesByCardId.remove(fromCardId)
            refreshAgentRunChildren(toCardId)
        } else if (toBlock.children.isEmpty() && fromBlock.children.isNotEmpty()) {
            toBlock.children = fromBlock.children
        }

        val index = blocks.indexOfFirst { it === fromBlock }
        if (index != -1) {
            blocks.removeAt(index)
        }
        toolBlocksById.remove(fromCardId)
        agentRunBlocksByCardId.remove(fromCardId)

        for ((fingerprint, pendingCardId) in pendingAgentRunCardByFingerprint.toList()) {
            if (pendingCardId == fromCardId) {
                pendingAgentRunCardByFingerprint[fingerprint] = toCardId
            }
        }
        for ((mappedAgentId, mappedCardId) in agentRunCardByAgentId.toList()) {
            if (mappedCardId == fromCardId) {
                agentRunCardByAgentId[mappedAgentId] = toCardId
            }
        }
    }

    // Pre-scan: UUIDs of system-injected user turns, used to spot the
    // "No response requested." sentinel auto-replies below.
    val injectedTurnUuids = mutableSetOf<String>()
    for (msg in messages) {
        val agent = msg as? NormalizedMessage.Agent ?: continue
        if (!agent.isSidechain) continue
        for (c in agent.content) {
            if (c is NormalizedAgentContent.Sidechain) {
                injectedTurnUuids.add(c.uuid)
            }
        }
    }

    for (msg in messages) {
        if (msg is NormalizedMessage.Event) {
            val eventType = msg.event.type
            if (eventType == "ready") {
                hasReadyEvent = true
                continue
            }
            if (eventType == "token-count") {
                continue
            }
            // abort-restore is a composer side-effect signal, not a chat event.
            if (eventType == "abort-restore") {
                continue
            }
            if (eventType == "turn-duration") {
                val raw = msg.event.raw
                val targetId = asString(raw["targetMessageId"])
                val durationMs = asNumber(raw["durationMs"])
                fun isDurationTarget(b: ChatBlock): Boolean =
                    b is AgentTextBlock || b is AgentReasoningBlock || b is CodexReviewBlock
                        || b is CliOutputBlock || b is ToolCallBlock

                var foundIndex = -1
                if (!targetId.isNullOrEmpty()) {
                    foundIndex = blocks.indexOfLast { b ->
                        isDurationTarget(b) && (b.id == targetId || b.id.startsWith("$targetId:"))
                    }
                    if (foundIndex == -1) {
                        foundIndex = blocks.indexOfLast { b -> b is ToolCallBlock && b.tool.id == targetId }
                    }
                }

                if (foundIndex == -1) {
                    foundIndex = blocks.indexOfLast(::isDurationTarget)
                }

                if (foundIndex != -1) {
                    when (val b = blocks[foundIndex]) {
                        is AgentTextBlock -> b.durationMs = durationMs
                        is AgentReasoningBlock -> b.durationMs = durationMs
                        is CodexReviewBlock -> b.durationMs = durationMs
                        is CliOutputBlock -> b.durationMs = durationMs
                        is ToolCallBlock -> b.durationMs = durationMs
                        else -> {}
                    }
                }
                continue
            }

            if (eventType == "agent-run-start" || eventType == "agent-run-update" || eventType == "agent-run-trace") {
                val event = msg.event.raw
                val agentId = getEventString(event, "agentId") ?: getEventString(event, "agent_id")
                val agentIdTruthy = !agentId.isNullOrEmpty()
                val fallbackCardId = if (agentIdTruthy) "codex-agent:$agentId" else msg.id
                val rawCardId = getAgentRunCardId(event, fallbackCardId)
                val previousCardId = if (agentIdTruthy) agentRunCardByAgentId[agentId] else null
                val previousIsFallback = previousCardId != null && isFallbackAgentRunCardId(previousCardId, agentId)
                val rawIsFallback = isFallbackAgentRunCardId(rawCardId, agentId)
                val cardId = if (agentIdTruthy && previousCardId != null && !previousIsFallback && rawIsFallback) {
                    previousCardId
                } else {
                    rawCardId
                }
                val mergeFromCardId = if (
                    agentIdTruthy && previousCardId != null && previousCardId != cardId
                    && previousIsFallback && !rawIsFallback
                ) previousCardId else null
                val fingerprint = getAgentRunFingerprint(event)

                if (
                    eventType == "agent-run-update"
                    && agentIdTruthy
                    && previousCardId == null
                    && rawIsFallback
                    && isAgentToolOnlyUpdate(event)
                ) {
                    continue
                }

                if (eventType == "agent-run-start" && !agentIdTruthy && !fingerprint.isNullOrEmpty()) {
                    val pendingPreviousCardId = pendingAgentRunCardByFingerprint[fingerprint]
                    val previousBlock = pendingPreviousCardId?.let { agentRunBlocksByCardId[it] }
                    if (
                        pendingPreviousCardId != null && pendingPreviousCardId != cardId
                        && previousBlock != null && isOrphanAgentRunBlock(previousBlock)
                    ) {
                        removeAgentRunBlock(pendingPreviousCardId)
                    }
                    pendingAgentRunCardByFingerprint[fingerprint] = cardId
                }

                val block = ensureAgentRunBlock(
                    cardId,
                    createdAt = msg.createdAt,
                    invokedAt = msg.invokedAt,
                    model = msg.model,
                    localId = msg.localId,
                    meta = msg.meta,
                    input = event["input"],
                )

                if (mergeFromCardId != null) {
                    mergeAgentRunBlock(mergeFromCardId, cardId, block)
                }
                if (agentIdTruthy) {
                    agentRunCardByAgentId[agentId!!] = cardId
                }

                if (eventType == "agent-run-start") {
                    val status = getEventString(event, "status") ?: "running"
                    val startedAt = getAgentRunStartedAt(event) ?: msg.createdAt.toDouble()
                    val patch = LinkedHashMap<String, JsonElement>()
                    patch["agentId"] = agentId?.let(::JsonPrimitive) ?: JsonNull
                    patch["agentStatus"] = JsonPrimitive(status)
                    patch["statusText"] = JsonPrimitive(
                        getEventString(event, "statusText") ?: getEventString(event, "status_text") ?: "Starting"
                    )
                    patch.putAll(getAgentRunDisplayPatch(event))
                    patchAgentRunInput(block, patch)
                    val nextState = mapAgentRunStatusToToolState(status)
                    block.tool = block.tool.copy(state = nextState)
                    if (nextState == ToolState.RUNNING) {
                        setEarliestStartedAt(block, startedAt)
                    }
                    continue
                }

                if (eventType == "agent-run-update") {
                    val status = getEventString(event, "status") ?: "running"
                    val nextState = mapAgentRunStatusToToolState(status)
                    val startedAt = getAgentRunStartedAt(event)
                    if (
                        shouldIgnoreAgentRunNonTerminalUpdateAfterTerminal(block, nextState, event)
                        || shouldIgnoreAgentRunCloseCleanupAfterTerminal(block, status, event)
                    ) {
                        continue
                    }
                    val patch = LinkedHashMap<String, JsonElement>()
                    patch["agentId"] = agentId?.let(::JsonPrimitive) ?: JsonNull
                    patch["agentStatus"] = JsonPrimitive(status)
                    patch["statusText"] = JsonPrimitive(
                        getEventString(event, "statusText") ?: getEventString(event, "status_text") ?: status
                    )
                    patch.putAll(getAgentRunDisplayPatch(event))
                    patchAgentRunInput(block, patch)
                    block.tool = block.tool.copy(state = nextState)
                    if (nextState == ToolState.RUNNING) {
                        setEarliestStartedAt(block, startedAt ?: msg.createdAt.toDouble())
                    }
                    if (nextState == ToolState.COMPLETED || nextState == ToolState.ERROR) {
                        setEarliestStartedAt(block, startedAt)
                        block.tool = block.tool.copy(
                            completedAt = getAgentRunCompletedAt(event) ?: msg.createdAt.toDouble()
                        )
                    }
                    if (event.containsKey("result")) {
                        block.tool = block.tool.copy(result = event.getValue("result"))
                    } else if (event.containsKey("error")) {
                        block.tool = block.tool.copy(result = event.getValue("error"))
                    } else if (event.containsKey("spawnResult")) {
                        block.tool = block.tool.copy(result = event.getValue("spawnResult"))
                    }
                    continue
                }

                if (eventType == "agent-run-trace") {
                    if (!agentIdTruthy) continue
                    val traceAgentId = agentId!!
                    val startedAt = getAgentRunStartedAt(event)
                    val traceCardId = agentRunCardByAgentId[traceAgentId] ?: cardId
                    val traceBlock = ensureAgentRunBlock(
                        traceCardId,
                        createdAt = msg.createdAt,
                        invokedAt = msg.invokedAt,
                        model = msg.model,
                        localId = msg.localId,
                        meta = msg.meta,
                        input = if (agentRunBlocksByCardId.containsKey(traceCardId)) {
                            null
                        } else {
                            buildJsonObject { put("agentId", traceAgentId) }
                        },
                    )
                    val tracePatch = LinkedHashMap<String, JsonElement>()
                    tracePatch["agentId"] = JsonPrimitive(traceAgentId)
                    tracePatch["agentStatus"] = JsonPrimitive(traceBlock.tool.state)
                    tracePatch.putAll(getAgentRunDisplayPatch(event))
                    if (!isTerminalAgentRunState(traceBlock.tool.state)) {
                        tracePatch["statusText"] = JsonPrimitive(
                            getEventString(event, "statusText") ?: getEventString(event, "status_text") ?: "Running"
                        )
                    }
                    patchAgentRunInput(traceBlock, tracePatch)
                    val traceMessages = agentRunTraceMessagesByCardId.getOrPut(traceCardId) { mutableListOf() }
                    traceMessages.addAll(normalizeTraceMessage(traceAgentId, event["message"], msg))
                    refreshAgentRunChildren(traceCardId)
                    if (traceBlock.tool.state != ToolState.COMPLETED && traceBlock.tool.state != ToolState.ERROR) {
                        traceBlock.tool = traceBlock.tool.copy(state = ToolState.RUNNING)
                        setEarliestStartedAt(traceBlock, startedAt ?: msg.createdAt.toDouble())
                    }
                    continue
                }
            }

            blocks.add(
                AgentEventBlock(
                    id = msg.id,
                    createdAt = msg.createdAt,
                    invokedAt = msg.invokedAt,
                    model = msg.model,
                    event = msg.event,
                    meta = msg.meta,
                )
            )
            continue
        }

        val parsedEvent = parseMessageAsEvent(msg)
        if (parsedEvent != null) {
            blocks.add(
                AgentEventBlock(
                    id = msg.id,
                    createdAt = msg.createdAt,
                    invokedAt = msg.invokedAt,
                    model = msg.model,
                    event = parsedEvent,
                    meta = msg.meta,
                )
            )
            continue
        }

        if (msg is NormalizedMessage.User) {
            if (isCliOutputText(msg.text, msg.meta)) {
                blocks.add(
                    createCliOutputBlock(
                        id = msg.id,
                        localId = msg.localId,
                        createdAt = msg.createdAt,
                        invokedAt = msg.invokedAt,
                        text = msg.text,
                        source = "user",
                        meta = msg.meta,
                    )
                )
                continue
            }
            blocks.add(
                UserTextBlock(
                    id = msg.id,
                    localId = msg.localId,
                    createdAt = msg.createdAt,
                    invokedAt = msg.invokedAt,
                    text = msg.text,
                    attachments = msg.attachments,
                    status = msg.status,
                    originalText = msg.originalText,
                    meta = msg.meta,
                )
            )
            continue
        }

        if (msg is NormalizedMessage.Agent) {
            // Suppress only the exact Task-prompt text echoed before a subagent tool_use.
            val taskToolCall = msg.content.firstOrNull { c ->
                c is NormalizedAgentContent.ToolUse && isSubagentToolName(c.name)
            } as? NormalizedAgentContent.ToolUse
            val taskPromptText: String? = taskToolCall?.let { toolUse ->
                asObject(toolUse.input)?.let { asString(it["prompt"]) }
            }

            for (idx in msg.content.indices) {
                when (val c = msg.content[idx]) {
                    is NormalizedAgentContent.Text -> {
                        // Skip "No response requested." sentinel auto-replies.
                        if (
                            msg.content.size == 1
                            && c.parentUUID != null
                            && injectedTurnUuids.contains(c.parentUUID)
                        ) {
                            val trimmedText = c.text.trim()
                            if (trimmedText == "No response requested." || trimmedText == "No response requested") {
                                continue
                            }
                        }

                        if (taskPromptText != null && c.text.trim() == taskPromptText.trim()) continue

                        if (isCliOutputText(c.text, msg.meta)) {
                            blocks.add(
                                createCliOutputBlock(
                                    id = "${msg.id}:$idx",
                                    localId = msg.localId,
                                    createdAt = msg.createdAt,
                                    invokedAt = msg.invokedAt,
                                    usage = msg.usage,
                                    model = msg.model,
                                    text = c.text,
                                    source = "assistant",
                                    meta = msg.meta,
                                )
                            )
                            continue
                        }
                        val streamId = c.streamId
                        if (streamId != null) {
                            val existing = textBlocksByStreamId[streamId]
                            if (existing != null) {
                                existing.text = c.text
                                existing.usage = msg.usage
                                existing.model = msg.model
                                existing.meta = msg.meta
                                existing.invokedAt = msg.invokedAt
                                continue
                            }
                        }

                        val block = AgentTextBlock(
                            id = "${msg.id}:$idx",
                            localId = msg.localId,
                            createdAt = msg.createdAt,
                            invokedAt = msg.invokedAt,
                            usage = msg.usage,
                            model = msg.model,
                            text = c.text,
                            meta = msg.meta,
                        )
                        blocks.add(block)
                        if (streamId != null) {
                            textBlocksByStreamId[streamId] = block
                        }
                    }

                    is NormalizedAgentContent.GeneratedImage -> {
                        blocks.add(
                            GeneratedImageBlock(
                                id = "${msg.id}:$idx",
                                localId = msg.localId,
                                createdAt = msg.createdAt,
                                invokedAt = msg.invokedAt,
                                imageId = c.imageId,
                                fileName = c.fileName,
                                mimeType = c.mimeType,
                                source = c.source,
                                meta = msg.meta,
                            )
                        )
                    }

                    is NormalizedAgentContent.Reasoning -> {
                        val streamId = c.streamId
                        if (streamId != null) {
                            val existing = reasoningBlocksByStreamId[streamId]
                            if (existing != null) {
                                existing.text = c.text
                                existing.usage = msg.usage
                                existing.model = msg.model
                                existing.meta = msg.meta
                                existing.invokedAt = msg.invokedAt
                                continue
                            }
                        }

                        val block = AgentReasoningBlock(
                            id = "${msg.id}:$idx",
                            localId = msg.localId,
                            createdAt = msg.createdAt,
                            invokedAt = msg.invokedAt,
                            usage = msg.usage,
                            model = msg.model,
                            text = c.text,
                            meta = msg.meta,
                        )
                        blocks.add(block)
                        if (streamId != null) {
                            reasoningBlocksByStreamId[streamId] = block
                        }
                    }

                    is NormalizedAgentContent.CodexReviewContent -> {
                        blocks.add(
                            CodexReviewBlock(
                                id = "${msg.id}:$idx",
                                localId = msg.localId,
                                createdAt = msg.createdAt,
                                invokedAt = msg.invokedAt,
                                usage = msg.usage,
                                model = msg.model,
                                review = c.review,
                                meta = msg.meta,
                            )
                        )
                    }

                    is NormalizedAgentContent.Summary -> {
                        blocks.add(
                            AgentEventBlock(
                                id = "${msg.id}:$idx",
                                createdAt = msg.createdAt,
                                invokedAt = msg.invokedAt,
                                model = msg.model,
                                event = AgentEvent.of(buildJsonObject {
                                    put("type", "message")
                                    put("message", c.summary)
                                }),
                                meta = msg.meta,
                            )
                        )
                    }

                    is NormalizedAgentContent.ToolUse -> {
                        if (isChangeTitleToolName(c.name)) {
                            val title = context.titleChangesByToolUseId[c.id] ?: extractTitleFromChangeTitleInput(c.input)
                            if (!title.isNullOrEmpty() && !context.emittedTitleChangeToolUseIds.contains(c.id)) {
                                context.emittedTitleChangeToolUseIds.add(c.id)
                                blocks.add(
                                    AgentEventBlock(
                                        id = "${msg.id}:$idx",
                                        createdAt = msg.createdAt,
                                        invokedAt = msg.invokedAt,
                                        model = msg.model,
                                        event = AgentEvent.of(buildJsonObject {
                                            put("type", "title-changed")
                                            put("title", title)
                                        }),
                                        meta = msg.meta,
                                    )
                                )
                            }
                            continue
                        }

                        val permission = context.permissionsById[c.id]?.permission

                        val block = ensureToolBlock(
                            blocks, toolBlocksById, c.id,
                            ToolBlockSeed(
                                createdAt = msg.createdAt,
                                invokedAt = msg.invokedAt,
                                usage = msg.usage,
                                model = msg.model,
                                localId = msg.localId,
                                meta = msg.meta,
                                name = c.name,
                                input = c.input,
                                description = c.description,
                                nativeTitle = c.nativeTitle,
                                nativeKind = c.nativeKind,
                                hasProgress = c.hasProgress,
                                progress = c.progress,
                                permission = permission,
                                agentTimestamp = msg.agentTimestamp,
                            )
                        )

                        if (block.tool.state == ToolState.PENDING) {
                            block.tool = block.tool.copy(state = ToolState.RUNNING)
                        }
                        // Backfill hub-clock and exec starts regardless of state so a
                        // tool_result reduced before its tool_use still lowers startedAt.
                        setEarliestStartedAt(block, msg.createdAt.toDouble())
                        setEarliestExecStartedAt(block, msg.agentTimestamp?.toDouble())

                        if (isSubagentToolName(c.name) && !context.consumedGroupIds.contains(msg.id)) {
                            val sidechain = context.groups[msg.id]
                            if (!sidechain.isNullOrEmpty()) {
                                context.consumedGroupIds.add(msg.id)
                                val child = reduceTimeline(sidechain, context)
                                hasReadyEvent = hasReadyEvent || child.hasReadyEvent
                                block.children = child.blocks
                            }
                        }
                    }

                    is NormalizedAgentContent.ToolResult -> {
                        val title = context.titleChangesByToolUseId[c.toolUseId]
                        if (title != null) {
                            if (!context.emittedTitleChangeToolUseIds.contains(c.toolUseId)) {
                                context.emittedTitleChangeToolUseIds.add(c.toolUseId)
                                blocks.add(
                                    AgentEventBlock(
                                        id = "${msg.id}:$idx",
                                        createdAt = msg.createdAt,
                                        invokedAt = msg.invokedAt,
                                        model = msg.model,
                                        event = AgentEvent.of(buildJsonObject {
                                            put("type", "title-changed")
                                            put("title", title)
                                        }),
                                        meta = msg.meta,
                                    )
                                )
                            }
                            continue
                        }

                        val permissionEntry = context.permissionsById[c.toolUseId]
                        val permissionFromResult = c.permissions?.let { permissions ->
                            ToolPermission(
                                id = c.toolUseId,
                                status = if (permissions.result == "approved") "approved" else "denied",
                                date = permissions.date,
                                mode = permissions.mode,
                                allowedTools = permissions.allowedTools,
                                decision = permissions.decision,
                                presence = ToolPermission.FROM_RESULT_KEYS,
                            )
                        }

                        val permission = run {
                            val entryPermission = permissionEntry?.permission
                            if (permissionFromResult != null && entryPermission != null) {
                                entryPermission.mergedWith(permissionFromResult).copy(
                                    allowedTools = permissionFromResult.allowedTools ?: entryPermission.allowedTools,
                                    decision = permissionFromResult.decision ?: entryPermission.decision,
                                )
                            } else {
                                permissionFromResult ?: entryPermission
                            }
                        }

                        val block = ensureToolBlock(
                            blocks, toolBlocksById, c.toolUseId,
                            ToolBlockSeed(
                                createdAt = msg.createdAt,
                                invokedAt = msg.invokedAt,
                                usage = msg.usage,
                                model = msg.model,
                                localId = msg.localId,
                                meta = msg.meta,
                                name = permissionEntry?.toolName ?: "Tool",
                                input = permissionEntry?.input ?: JsonNull,
                                description = null,
                                permission = permission,
                                // NOTE: no agentTimestamp seed here — execStartedAt must
                                // only ever originate from a tool_use entry.
                            )
                        )

                        block.tool = block.tool.copy(
                            result = c.content,
                            completedAt = msg.createdAt.toDouble(),
                            execCompletedAt = msg.agentTimestamp?.toDouble(),
                            state = if (c.isError) ToolState.ERROR else ToolState.COMPLETED,
                        )
                    }

                    is NormalizedAgentContent.Sidechain -> {
                        // Extract task-notification summaries as visible events.
                        val trimmedPrompt = c.prompt.trimStart()
                        if (trimmedPrompt.startsWith("<task-notification>")) {
                            val summary = Regex("<summary>([\\s\\S]*?)</summary>")
                                .find(trimmedPrompt)?.groupValues?.get(1)?.trim()
                            if (!summary.isNullOrEmpty()) {
                                blocks.add(
                                    AgentEventBlock(
                                        id = "${msg.id}:$idx",
                                        createdAt = msg.createdAt,
                                        invokedAt = msg.invokedAt,
                                        model = msg.model,
                                        event = AgentEvent.of(buildJsonObject {
                                            put("type", "message")
                                            put("message", summary)
                                        }),
                                        meta = msg.meta,
                                    )
                                )
                            }
                        }
                        // Prompt text itself is not rendered (already in the Task card).
                    }
                }
            }
        }
    }

    return TimelineResult(mergeCliOutputBlocks(blocks), toolBlocksById, hasReadyEvent)
}

package app.hapi.protocol.chat

/** Port of `web/src/chat/tracer.ts` — groups sidechain messages under their parent Task/Agent card. */

data class TracedMessage(
    val message: NormalizedMessage,
    val sidechainId: String? = null,
)

private class TracerState {
    val promptToTaskId = HashMap<String, String>()
    val toolUseIdToTaskId = HashMap<String, String>()
    val uuidToSidechainId = HashMap<String, String>()
    val orphanMessages = HashMap<String, MutableList<NormalizedMessage>>()
}

private fun getMessageUuid(message: NormalizedMessage): String? {
    if (message is NormalizedMessage.Agent && message.content.isNotEmpty()) {
        return message.content.first().uuidOrNull()
    }
    return null
}

private fun getParentUuid(message: NormalizedMessage): String? {
    if (message is NormalizedMessage.Agent && message.content.isNotEmpty()) {
        return message.content.first().parentUuidOrNull()
    }
    return null
}

private fun getParentToolUseId(message: NormalizedMessage): String? =
    (message as? NormalizedMessage.Agent)?.parentToolUseId

private fun processOrphans(state: TracerState, parentUuid: String, sidechainId: String): List<TracedMessage> {
    val results = mutableListOf<TracedMessage>()
    val orphans = state.orphanMessages.remove(parentUuid) ?: return results

    for (orphan in orphans) {
        val uuid = getMessageUuid(orphan)
        if (uuid != null) {
            state.uuidToSidechainId[uuid] = sidechainId
        }

        results.add(TracedMessage(orphan, sidechainId))

        if (uuid != null) {
            results.addAll(processOrphans(state, uuid, sidechainId))
        }
    }

    return results
}

fun traceMessages(messages: List<NormalizedMessage>): List<TracedMessage> {
    val state = TracerState()
    val results = mutableListOf<TracedMessage>()

    // Index Task/Agent prompts and tool_use ids (including those inside sidechains).
    for (message in messages) {
        val agent = message as? NormalizedMessage.Agent ?: continue
        for (content in agent.content) {
            val toolUse = content as? NormalizedAgentContent.ToolUse ?: continue
            if (!isSubagentToolName(toolUse.name)) continue
            state.toolUseIdToTaskId[toolUse.id] = message.id
            val input = asObject(toolUse.input) ?: continue
            val prompt = asString(input["prompt"]) ?: continue
            state.promptToTaskId[prompt] = message.id
        }
    }

    for (message in messages) {
        if (!message.isSidechain) {
            results.add(TracedMessage(message))
            continue
        }

        val uuid = getMessageUuid(message)
        val parentUuid = getParentUuid(message)

        // Preferred: group by the SDK-preserved parentToolUseId.
        var sidechainId: String? = null
        val parentToolUseId = getParentToolUseId(message)
        if (!parentToolUseId.isNullOrEmpty()) {
            sidechainId = state.toolUseIdToTaskId[parentToolUseId]
        }

        // Fallback: sidechain-root prompt matching (pre-parentToolUseId messages).
        if (sidechainId.isNullOrEmpty() && message is NormalizedMessage.Agent) {
            for (content in message.content) {
                val sidechain = content as? NormalizedAgentContent.Sidechain ?: continue
                val taskId = state.promptToTaskId[sidechain.prompt]
                if (taskId != null) {
                    sidechainId = taskId
                    break
                }
            }
        }

        if (!sidechainId.isNullOrEmpty() && !uuid.isNullOrEmpty()) {
            state.uuidToSidechainId[uuid] = sidechainId
            results.add(TracedMessage(message, sidechainId))
            results.addAll(processOrphans(state, uuid, sidechainId))
            continue
        }

        if (!parentUuid.isNullOrEmpty()) {
            val parentSidechainId = state.uuidToSidechainId[parentUuid]
            if (parentSidechainId != null) {
                if (!uuid.isNullOrEmpty()) {
                    state.uuidToSidechainId[uuid] = parentSidechainId
                }
                results.add(TracedMessage(message, parentSidechainId))
                if (!uuid.isNullOrEmpty()) {
                    results.addAll(processOrphans(state, uuid, parentSidechainId))
                }
            } else {
                state.orphanMessages.getOrPut(parentUuid) { mutableListOf() }.add(message)
            }
            continue
        }

        results.add(TracedMessage(message))
    }

    return results
}

package app.hapi.protocol.chat

/**
 * Summed metadata for one response group (a run of assistant-role blocks
 * bounded by user text / agent events / user-source CLI output).
 *
 * When injected onto the group's first block these values REPLACE that
 * block's own per-message fields (the aggregation is the more complete
 * view); [durationMs] is always null — a group has no single duration.
 */
class AggregatedAssistantMeta(
    val usage: UsageData? = null,
    val model: String? = null,
    val invokedAt: Long? = null,
    val durationMs: Double? = null,
    val turnCount: Int,
    val roundSummary: RoundSummary? = null,
)

private class TurnSource(
    val localId: String?,
    val invokedAt: Long?,
    val durationMs: Double?,
    val model: String?,
    val usage: UsageData?,
    val createdAt: Long,
)

/**
 * One turn source per underlying agent message the visible block
 * represents. A tool group is a derived view over several tool calls that
 * were merged without checking that they share a turn, so each member
 * contributes its own source; other assistant kinds map to one source.
 */
private fun turnSourcesFromBlock(block: VisibleChatBlock): List<TurnSource> = when (block) {
    is ToolGroupBlock -> block.tools.map { it.toTurnSource() }
    is AgentTextBlock -> listOf(block.toTurnSource())
    is AgentReasoningBlock -> listOf(block.toTurnSource())
    is CliOutputBlock -> listOf(block.toTurnSource())
    is ToolCallBlock -> listOf(block.toTurnSource())
    else -> emptyList()
}

private fun AgentTextBlock.toTurnSource(): TurnSource = TurnSource(
    localId = localId,
    invokedAt = invokedAt,
    durationMs = durationMs,
    model = model,
    usage = usage,
    createdAt = createdAt,
)

private fun AgentReasoningBlock.toTurnSource(): TurnSource = TurnSource(
    localId = localId,
    invokedAt = invokedAt,
    durationMs = durationMs,
    model = model,
    usage = usage,
    createdAt = createdAt,
)

private fun CliOutputBlock.toTurnSource(): TurnSource = TurnSource(
    localId = localId,
    invokedAt = invokedAt,
    durationMs = durationMs,
    model = model,
    usage = usage,
    createdAt = createdAt,
)

private fun ToolCallBlock.toTurnSource(): TurnSource = TurnSource(
    localId = localId,
    invokedAt = invokedAt,
    durationMs = durationMs,
    model = model,
    usage = usage,
    createdAt = createdAt,
)

/**
 * Fallback turn key when no CLI-stamped `localId` exists. Combines
 * `(model, usage totals, createdAt)`: every block derived from one agent
 * message shares its createdAt and collapses to one turn, while distinct
 * messages stay distinct even with coinciding token totals.
 */
private fun turnFingerprint(model: String?, usage: UsageData?, createdAt: Long): String {
    if (usage == null) return "m=${model ?: ""}|u=|c=$createdAt"
    return listOf(
        "m=${model ?: ""}",
        "i=${usage.inputTokens}",
        "o=${usage.outputTokens}",
        "cc=${usage.cacheCreationInputTokens ?: ""}",
        "cr=${usage.cacheReadInputTokens ?: ""}",
        "t=${usage.serviceTier ?: ""}",
        "c=$createdAt",
    ).joinToString("|")
}

/**
 * Sum two optional token counters. Null only when both operands are
 * absent; an explicit 0 on either side participates in the sum so a 0+0
 * total stays 0 instead of collapsing to null.
 */
private fun sumOptional(a: Double?, b: Double?): Double? {
    if (a == null && b == null) return null
    return (a ?: 0.0) + (b ?: 0.0)
}

private fun addUsage(target: UsageData, addend: UsageData): UsageData = UsageData(
    inputTokens = target.inputTokens + addend.inputTokens,
    outputTokens = target.outputTokens + addend.outputTokens,
    cacheCreationInputTokens = sumOptional(target.cacheCreationInputTokens, addend.cacheCreationInputTokens),
    cacheReadInputTokens = sumOptional(target.cacheReadInputTokens, addend.cacheReadInputTokens),
    // A mixed-tier group reports the first turn's tier.
    serviceTier = target.serviceTier,
)

/**
 * Presentation timestamp of a block — when the reader saw it settle. Tool
 * activity uses its latest completion; everything else its creation.
 */
internal fun getBlockPresentationTimestamp(block: VisibleChatBlock): Long = when (block) {
    is UserTextBlock -> block.invokedAt ?: block.createdAt
    is CliOutputBlock -> if (block.source == "user") {
        block.invokedAt ?: block.createdAt
    } else {
        block.createdAt
    }
    is ToolGroupBlock -> block.tools.fold(block.createdAt) { latest, tool ->
        maxOf(latest, tool.tool.completedAt?.toLong() ?: tool.createdAt)
    }
    is ToolCallBlock -> maxOf(block.createdAt, block.tool.completedAt?.toLong() ?: block.createdAt)
    else -> (block as ChatBlock).createdAt
}

private fun VisibleChatBlock.idValue(): String = when (this) {
    is ChatBlock -> id
    is ToolGroupBlock -> id
}

/**
 * Walk the visible block list, identify response groups, and return a map
 * keyed by each group's first visible block id holding the summed
 * metadata. Only groups spanning two or more distinct turns — or carrying
 * a round summary — produce an entry, so single-turn groups are untouched.
 */
fun aggregateResponseGroups(blocks: List<VisibleChatBlock>): Map<String, AggregatedAssistantMeta> {
    val aggregates = LinkedHashMap<String, AggregatedAssistantMeta>()
    var groupFirstBlockId: String? = null
    // Ordering-based turn dedup: only the immediately previous turn's key
    // dedups. A set of all seen keys would collapse a third turn whose
    // fingerprint matches a non-adjacent earlier turn, under-counting the
    // visible turn count.
    var prevTurnKey: String? = null
    val seenModels = mutableListOf<String>()
    var groupInvokedAt: Long? = null
    var groupUsage: UsageData? = null
    var groupTurnCount = 0
    var groupRoundSummary: RoundSummary? = null
    var groupStartedAt: Long? = null
    var groupCompletedAt: Long? = null
    var latestUserInvokedAt: Long? = null

    fun flush() {
        // Native turn summaries arrive without a duration; synthesize one
        // from the group's observed activity window.
        val roundSummary = groupRoundSummary
        val startedAt = groupStartedAt
        val completedAt = groupCompletedAt
        val synthesized = if (
            roundSummary != null &&
            roundSummary.provider == "codex" &&
            roundSummary.durationMs == null &&
            startedAt != null &&
            completedAt != null
        ) {
            roundSummary.copy(durationMs = maxOf(0.0, (completedAt - startedAt).toDouble()))
        } else {
            roundSummary
        }
        val firstBlockId = groupFirstBlockId
        if (firstBlockId != null && (groupTurnCount >= 2 || roundSummary != null)) {
            aggregates[firstBlockId] = AggregatedAssistantMeta(
                usage = groupUsage,
                model = if (seenModels.isNotEmpty()) seenModels.joinToString(", ") else null,
                invokedAt = groupInvokedAt,
                durationMs = null,
                turnCount = groupTurnCount,
                roundSummary = synthesized,
            )
        }
        groupFirstBlockId = null
        prevTurnKey = null
        seenModels.clear()
        groupInvokedAt = null
        groupUsage = null
        groupTurnCount = 0
        groupRoundSummary = null
        groupStartedAt = null
        groupCompletedAt = null
    }

    for (block in blocks) {
        if (visibleBlockRole(block) != "assistant") {
            // Boundary: close the open group, if any.
            flush()
            if (block is UserTextBlock) {
                latestUserInvokedAt = block.invokedAt
            }
            continue
        }

        if (groupFirstBlockId == null) {
            groupFirstBlockId = block.idValue()
            groupStartedAt = latestUserInvokedAt
        }
        groupCompletedAt = maxOf(groupCompletedAt ?: 0L, getBlockPresentationTimestamp(block))

        val roundSummary = when (block) {
            is ToolGroupBlock -> block.roundSummary
            is UserTextBlock, is AgentEventBlock -> null
            else -> roundSummaryOf(block as ChatBlock)
        }
        if (groupRoundSummary == null) {
            groupRoundSummary = roundSummary
        }

        for (turn in turnSourcesFromBlock(block)) {
            // Prefer the CLI-stamped localId; fall back to a fingerprint
            // built from (model, usage totals, createdAt).
            val turnKey = if (turn.localId != null) {
                "id:${turn.localId}"
            } else {
                "fp:${turnFingerprint(turn.model, turn.usage, turn.createdAt)}"
            }

            // Blocks with no turn signal at all (no localId, no usage, no
            // model) must not inflate the turn count.
            if (turn.localId == null && turn.usage == null && turn.model == null) continue

            // Only the immediately previous turn's key dedups; non-adjacent
            // repeats keep their separate counts.
            if (turnKey == prevTurnKey) continue
            prevTurnKey = turnKey

            groupTurnCount += 1
            val turnInvokedAt = turn.invokedAt
            val currentInvokedAt = groupInvokedAt
            if (turnInvokedAt != null && (currentInvokedAt == null || turnInvokedAt < currentInvokedAt)) {
                groupInvokedAt = turnInvokedAt
            }
            if (turn.model != null && turn.model !in seenModels) {
                seenModels.add(turn.model)
            }
            if (turn.usage != null) {
                groupUsage = groupUsage?.let { addUsage(it, turn.usage) } ?: turn.usage.copy()
            }
        }
    }

    flush()
    return aggregates
}

/**
 * Metadata input for one visible block: the block's own usage fields,
 * replaced wholesale by the response-group aggregate when the block is its
 * group's first block. Null when the block kind carries no usage metadata
 * and no aggregate applies.
 */
fun messageMetadataForBlock(
    block: VisibleChatBlock,
    aggregates: Map<String, AggregatedAssistantMeta> = emptyMap(),
): MessageMetadataInput? {
    val base: MessageMetadataInput? = when (block) {
        is AgentTextBlock -> MessageMetadataInput(block.durationMs, block.usage, block.model)
        is AgentReasoningBlock -> MessageMetadataInput(block.durationMs, block.usage, block.model)
        is CodexReviewBlock -> MessageMetadataInput(block.durationMs, block.usage, block.model)
        is CliOutputBlock -> if (block.source == "user") {
            null
        } else {
            MessageMetadataInput(block.durationMs, block.usage, block.model)
        }
        is ToolCallBlock -> MessageMetadataInput(block.durationMs, block.usage, block.model)
        else -> null
    }
    val aggregate = aggregates[block.idValue()] ?: return base
    return MessageMetadataInput(
        durationMs = aggregate.durationMs,
        usage = aggregate.usage,
        model = aggregate.model,
        turnCount = aggregate.turnCount,
        roundSummary = aggregate.roundSummary,
    )
}

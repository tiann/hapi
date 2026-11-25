package app.hapi.protocol.chat

import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Boundary behavior of the response-group aggregation: turn identity,
 * dedup rules, counter summation, codex duration synthesis, and the
 * per-kind metadata mapping.
 */
class ResponseGroupAggregationTest {

    private fun usage(
        input: Double,
        output: Double,
        tier: String? = null,
        cacheCreation: Double? = null,
        cacheRead: Double? = null,
    ) = UsageData(
        inputTokens = input,
        outputTokens = output,
        serviceTier = tier,
        cacheCreationInputTokens = cacheCreation,
        cacheReadInputTokens = cacheRead,
    )

    private fun text(
        id: String,
        createdAt: Long = 0,
        localId: String? = null,
        model: String? = null,
        usage: UsageData? = null,
        roundSummary: RoundSummary? = null,
    ) = AgentTextBlock(
        id = id, localId = localId, createdAt = createdAt, invokedAt = null,
        usage = usage, model = model, roundSummary = roundSummary,
        text = "t-$id", meta = null,
    )

    private fun user(id: String, createdAt: Long = 0, invokedAt: Long? = null) =
        UserTextBlock(
            id = id, localId = null, createdAt = createdAt, invokedAt = invokedAt,
            text = "u-$id", attachments = null, status = null, originalText = null, meta = null,
        )

    private fun tool(
        id: String,
        createdAt: Long = 0,
        localId: String? = null,
        invokedAt: Long? = null,
        model: String? = null,
        usage: UsageData? = null,
        completedAt: Double? = null,
    ) = ToolCallBlock(
        id = id, localId = localId, createdAt = createdAt, invokedAt = invokedAt,
        durationMs = null, usage = usage, model = model,
        tool = ChatToolCall(
            id, "Read", "completed", input = null, createdAt = createdAt,
            completedAt = completedAt, description = null,
        ),
        children = emptyList(), meta = null,
    )

    private fun group(
        id: String,
        members: List<ToolCallBlock>,
        createdAt: Long = members.first().createdAt,
    ) = ToolGroupBlock(
        id = id, createdAt = createdAt, invokedAt = members.first().invokedAt,
        firstToolId = members.first().id, lastToolId = members.last().id,
        tools = members, defaultOpen = false,
        historyState = "complete", needsOlderHistory = false, activityTitle = null,
        presentationMode = "default",
        summary = ToolGroupSummary(
            totalTools = members.size, countsByKind = emptyMap(), fileTargets = emptyList(),
            commandTargets = emptyList(), searchTargets = emptyList(), urlTargets = emptyList(),
            otherTargets = emptyList(), errorCount = 0, runningCount = 0, pendingCount = 0,
        ),
    )

    /** The projected form the transcript renders: member payloads stripped. */
    private fun ToolGroupBlock.stripped() = ToolGroupBlock(
        id, createdAt, invokedAt, firstToolId, lastToolId, emptyList(), defaultOpen,
        historyState, needsOlderHistory, activityTitle, presentationMode,
        roundSummary, summary,
    )

    private fun aggregates(vararg blocks: VisibleChatBlock) = aggregateResponseGroups(blocks.toList())

    @Test fun `adjacent duplicate turns collapse to one`() {
        // Two blocks sharing (model, usage, createdAt) are one turn; the
        // following distinct turn makes the group emit.
        val u = usage(10.0, 20.0)
        val result = aggregates(
            text("a", createdAt = 100, model = "m", usage = u),
            text("b", createdAt = 100, model = "m", usage = u),
            text("c", createdAt = 300, model = "m", usage = u),
        )
        assertEquals(listOf("a"), result.keys.toList())
        assertEquals(2, result.getValue("a").turnCount)
    }

    @Test fun `non-adjacent repeats keep their own counts`() {
        // An all-seen-keys set would collapse the third block onto the first
        // (same fingerprint) and under-count the visible turns.
        val u = usage(10.0, 20.0)
        val result = aggregates(
            text("a", createdAt = 100, model = "m", usage = u),
            text("b", createdAt = 200, model = "m", usage = u),
            text("c", createdAt = 100, model = "m", usage = u),
        )
        assertEquals(3, result.getValue("a").turnCount)
    }

    @Test fun `a shared local id dedups turns with different fingerprints`() {
        val result = aggregates(
            text("a", createdAt = 100, localId = "L", usage = usage(1.0, 2.0)),
            text("b", createdAt = 200, localId = "L", usage = usage(50.0, 60.0)),
            text("c", createdAt = 300, localId = "M", usage = usage(7.0, 8.0)),
        )
        assertEquals(2, result.getValue("a").turnCount)
        // The deduped turn contributes nothing; the counters come from the
        // first and last turns only.
        assertEquals(8.0, result.getValue("a").usage?.inputTokens)
    }

    @Test fun `distinct local ids count separately even with identical fingerprints`() {
        val u = usage(10.0, 20.0)
        val result = aggregates(
            text("a", createdAt = 100, localId = "L1", model = "m", usage = u),
            text("b", createdAt = 100, localId = "L2", model = "m", usage = u),
        )
        assertEquals(2, result.getValue("a").turnCount)
    }

    @Test fun `blocks with no turn signal do not inflate the count`() {
        val result = aggregates(
            text("silent"),
            text("a", createdAt = 100, localId = "L1"),
            text("b", createdAt = 200, localId = "L2"),
        )
        // The group entry is keyed by its first block, signal or not.
        assertEquals(2, result.getValue("silent").turnCount)
        // A group of only silent blocks never emits.
        assertTrue(aggregateResponseGroups(listOf(text("only-silent"))).isEmpty())
    }

    @Test fun `explicit zero cache counters sum to zero instead of null`() {
        val result = aggregates(
            text("a", createdAt = 100, localId = "L1", usage = usage(1.0, 1.0, cacheCreation = 0.0, cacheRead = 0.0)),
            text("b", createdAt = 200, localId = "L2", usage = usage(1.0, 1.0, cacheCreation = 0.0, cacheRead = 0.0)),
        )
        assertEquals(0.0, result.getValue("a").usage?.cacheCreationInputTokens)
        assertEquals(0.0, result.getValue("a").usage?.cacheReadInputTokens)
    }

    @Test fun `absent cache counters on both sides stay null`() {
        val result = aggregates(
            text("a", createdAt = 100, localId = "L1", usage = usage(1.0, 1.0)),
            text("b", createdAt = 200, localId = "L2", usage = usage(2.0, 2.0)),
        )
        assertNull(result.getValue("a").usage?.cacheCreationInputTokens)
        assertNull(result.getValue("a").usage?.cacheReadInputTokens)
    }

    @Test fun `models keep first-seen order`() {
        val result = aggregates(
            text("a", createdAt = 100, localId = "L1", model = "m2", usage = usage(1.0, 1.0)),
            text("b", createdAt = 200, localId = "L2", model = "m1", usage = usage(1.0, 1.0)),
            text("c", createdAt = 300, localId = "L3", model = "m2", usage = usage(1.0, 1.0)),
        )
        assertEquals("m2, m1", result.getValue("a").model)
    }

    @Test fun `a mixed-tier group reports the first tier`() {
        val result = aggregates(
            text("a", createdAt = 100, localId = "L1", usage = usage(1.0, 1.0, tier = "priority")),
            text("b", createdAt = 200, localId = "L2", usage = usage(1.0, 1.0, tier = "standard")),
        )
        assertEquals("priority", result.getValue("a").usage?.serviceTier)
    }

    @Test fun `a user boundary closes the open group`() {
        val u = usage(10.0, 20.0)
        val result = aggregates(
            text("a", createdAt = 100, model = "m", usage = u),
            user("u1"),
            text("b", createdAt = 100, model = "m", usage = u),
        )
        // Each side is a single-turn group: nothing emits.
        assertTrue(result.isEmpty())
    }

    @Test fun `single-turn groups produce no entry`() {
        assertTrue(aggregateResponseGroups(listOf(text("a", createdAt = 100, localId = "L", model = "m", usage = usage(1.0, 2.0)))).isEmpty())
    }

    @Test fun `a single-turn tool group salvages the shared turn's metadata`() {
        // One assistant message → several groupable tool calls sharing one
        // source (localId + usage). Projection will strip the members, so the
        // group block itself must carry the turn's metadata.
        val u = usage(10.0, 20.0)
        val members = listOf(
            tool("t1", createdAt = 100, localId = "L", model = "m", usage = u),
            tool("t2", createdAt = 100, localId = "L", model = "m", usage = u),
            tool("t3", createdAt = 100, localId = "L", model = "m", usage = u),
        )
        val result = aggregates(group("g", members))
        val entry = result.getValue("g")
        // The members share one turn: usage counts once, not three times.
        assertEquals(usage(10.0, 20.0), entry.usage)
        assertEquals("m", entry.model)
        assertEquals(1, entry.turnCount)
        assertNull(entry.roundSummary)
    }

    @Test fun `a salvaged tool group keeps its details after projection strips members`() {
        val u = usage(10.0, 20.0)
        val members = listOf(
            tool("t1", createdAt = 100, localId = "L", model = "m", usage = u),
            tool("t2", createdAt = 100, localId = "L", model = "m", usage = u),
        )
        val full = group("g", members)
        val aggregates = aggregateResponseGroups(listOf(full))
        // The transcript renders the stripped form; the metadata map must
        // still resolve it to a non-empty label set.
        val metadata = messageMetadataForBlock(full.stripped(), aggregates)
        assertEquals(u, metadata?.usage)
        assertEquals("m", metadata?.model)
        assertTrue(metadata?.let(::buildMessageMetadataLabels).orEmpty().isNotEmpty())
    }

    @Test fun `a tool group without local ids dedups its turn by fingerprint`() {
        // No CLI-stamped localId: members of one message share (model, usage,
        // createdAt) and collapse to one salvaged turn.
        val u = usage(10.0, 20.0)
        val result = aggregates(
            group(
                "g",
                listOf(
                    tool("t1", createdAt = 100, model = "m", usage = u),
                    tool("t2", createdAt = 100, model = "m", usage = u),
                ),
            ),
        )
        assertEquals(1, result.getValue("g").turnCount)
        assertEquals(u, result.getValue("g").usage)
    }

    @Test fun `a multi-turn tool group aggregates instead of salvaging`() {
        // Distinct source messages inside one group: the normal >=2-turn
        // aggregation path sums both turns.
        val result = aggregates(
            group(
                "g",
                listOf(
                    tool("t1", createdAt = 100, localId = "L1", model = "m", usage = usage(10.0, 20.0)),
                    tool("t2", createdAt = 200, localId = "L2", model = "m", usage = usage(1.0, 2.0)),
                ),
            ),
        )
        val entry = result.getValue("g")
        assertEquals(2, entry.turnCount)
        assertEquals(11.0, entry.usage?.inputTokens)
    }

    @Test fun `a silent single-turn tool group salvages nothing`() {
        // Members without usage, model or ids carry nothing to preserve.
        val result = aggregates(
            group("g", listOf(tool("t1", createdAt = 100), tool("t2", createdAt = 100))),
        )
        assertTrue(result.isEmpty())
        assertNull(messageMetadataForBlock(group("g", listOf(tool("t1"))).stripped(), result))
    }

    @Test fun `a single-turn group led by text stays untouched`() {
        // Text first: the block keeps its own metadata (duration included);
        // no salvage entry replaces it.
        val block = text("a", createdAt = 100, localId = "L", model = "m", usage = usage(1.0, 2.0))
        block.durationMs = 111.0
        val result = aggregates(
            block,
            group(
                "g",
                listOf(
                    tool("t1", createdAt = 100, localId = "L", model = "m", usage = usage(1.0, 2.0)),
                    tool("t2", createdAt = 100, localId = "L", model = "m", usage = usage(1.0, 2.0)),
                ),
            ),
        )
        assertTrue(result.isEmpty())
        val metadata = messageMetadataForBlock(block, result)
        assertEquals(111.0, metadata?.durationMs)
    }

    @Test fun `a round summary alone emits an entry`() {
        val summary = RoundSummary(provider = "claude", numTurns = 1.0, durationMs = 900.0)
        val result = aggregateResponseGroups(listOf(text("a", createdAt = 100, localId = "L", roundSummary = summary)))
        val entry = result.getValue("a")
        assertEquals(1, entry.turnCount)
        assertEquals(summary, entry.roundSummary)
    }

    @Test fun `codex summary duration is synthesized from the activity window`() {
        val result = aggregates(
            user("u1", createdAt = 100, invokedAt = 1_000),
            text("a", createdAt = 3_000, localId = "L", roundSummary = RoundSummary(provider = "codex", numTurns = 1.0)),
        )
        assertEquals(2_000.0, result.getValue("a").roundSummary?.durationMs)
    }

    @Test fun `a negative codex activity window clamps to zero`() {
        val result = aggregates(
            user("u1", createdAt = 100, invokedAt = 5_000),
            text("a", createdAt = 3_000, localId = "L", roundSummary = RoundSummary(provider = "codex", numTurns = 1.0)),
        )
        assertEquals(0.0, result.getValue("a").roundSummary?.durationMs)
    }

    @Test fun `a summary with its own duration is not synthesized over`() {
        val result = aggregates(
            user("u1", createdAt = 100, invokedAt = 1_000),
            text("a", createdAt = 9_000, localId = "L", roundSummary = RoundSummary(provider = "codex", numTurns = 1.0, durationMs = 42.0)),
        )
        assertEquals(42.0, result.getValue("a").roundSummary?.durationMs)
    }

    @Test fun `non-codex summaries keep a missing duration`() {
        val result = aggregates(
            user("u1", createdAt = 100, invokedAt = 1_000),
            text("a", createdAt = 3_000, localId = "L", roundSummary = RoundSummary(provider = "claude", numTurns = 1.0)),
        )
        assertNull(result.getValue("a").roundSummary?.durationMs)
    }

    @Test fun `an aggregate entry replaces the block's own metadata fields`() {
        val block = text(
            "a", createdAt = 100, localId = "L",
            model = "own-model", usage = usage(1.0, 2.0),
        )
        block.durationMs = 111.0
        val aggregate = AggregatedAssistantMeta(
            usage = usage(5.0, 6.0), model = "agg-model", turnCount = 2,
        )
        val metadata = messageMetadataForBlock(block, mapOf("a" to aggregate))
        assertNull(metadata?.durationMs)
        assertEquals(usage(5.0, 6.0), metadata?.usage)
        assertEquals("agg-model", metadata?.model)
        assertEquals(2, metadata?.turnCount)
    }

    @Test fun `blocks without an aggregate keep their own metadata`() {
        val block = text("a", createdAt = 100, model = "m", usage = usage(1.0, 2.0))
        block.durationMs = 111.0
        val metadata = messageMetadataForBlock(block)
        assertEquals(111.0, metadata?.durationMs)
        assertEquals("m", metadata?.model)
        assertNull(metadata?.turnCount)
    }

    @Test fun `per-kind base metadata mapping`() {
        assertNull(messageMetadataForBlock(user("u")))
        assertNull(
            messageMetadataForBlock(
                GeneratedImageBlock(
                    id = "g", localId = null, createdAt = 0, invokedAt = null,
                    imageId = "img", fileName = "f.png", mimeType = null, source = null,
                    meta = null,
                )
            )
        )
        assertNull(
            messageMetadataForBlock(
                CliOutputBlock(
                    id = "c", localId = null, createdAt = 0, invokedAt = null,
                    text = "out", source = "user", meta = null,
                )
            )
        )
        val assistantCli = CliOutputBlock(
            id = "c2", localId = null, createdAt = 0, invokedAt = null,
            durationMs = 5.0, usage = usage(1.0, 2.0), model = "m",
            text = "out", source = "assistant", meta = null,
        )
        val cliMetadata = messageMetadataForBlock(assistantCli)
        assertEquals(5.0, cliMetadata?.durationMs)
        assertEquals("m", cliMetadata?.model)

        val tool = ToolCallBlock(
            id = "t", localId = null, createdAt = 0, invokedAt = null,
            durationMs = 7.0, usage = usage(3.0, 4.0), model = "m2",
            tool = ChatToolCall("t", "Read", "completed", input = null, createdAt = 0, description = null),
            children = emptyList(), meta = null,
        )
        val toolMetadata = messageMetadataForBlock(tool)
        assertEquals(7.0, toolMetadata?.durationMs)
        assertEquals(3.0, toolMetadata?.usage?.inputTokens)
    }

    @Test fun `presentation timestamps prefer completion and invocation stamps`() {
        assertEquals(900, getBlockPresentationTimestamp(user("u", createdAt = 100, invokedAt = 900)))
        assertEquals(100, getBlockPresentationTimestamp(user("u", createdAt = 100)))

        val tool = ToolCallBlock(
            id = "t", localId = null, createdAt = 100, invokedAt = null,
            tool = ChatToolCall(
                "t", "Read", "completed", input = null, createdAt = 100, completedAt = 500.0,
                description = null,
            ),
            children = emptyList(), meta = null,
        )
        assertEquals(500, getBlockPresentationTimestamp(tool))

        val group = ToolGroupBlock(
            id = "g", createdAt = 100, invokedAt = null, firstToolId = "t1", lastToolId = "t1",
            tools = listOf(tool), defaultOpen = false,
            historyState = "complete", needsOlderHistory = false, activityTitle = null,
            presentationMode = "default",
            summary = ToolGroupSummary(
                totalTools = 1, countsByKind = emptyMap(), fileTargets = emptyList(),
                commandTargets = emptyList(), searchTargets = emptyList(), urlTargets = emptyList(),
                otherTargets = emptyList(), errorCount = 0, runningCount = 0, pendingCount = 0,
            ),
        )
        assertEquals(500, getBlockPresentationTimestamp(group))
        assertEquals(100, getBlockPresentationTimestamp(text("x", createdAt = 100)))
    }
}

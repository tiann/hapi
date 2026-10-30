package app.hapi.protocol.chat

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

/**
 * Wire decoding of round summaries, the turn-summary/turn-duration event
 * synthesis, and the reducer rules that attach summaries onto blocks.
 */
class RoundSummaryDecodeTest {

    private fun json(text: String): JsonObject = assertIs(Json.parseToJsonElement(text))

    // ------------------------------------------------------------------
    // normalizeRoundSummary — wire shapes
    // ------------------------------------------------------------------

    @Test fun `decodes every field of a full wire summary`() {
        val summary = normalizeRoundSummary(
            json(
                """
                {
                  "usage": {"input_tokens": 80, "output_tokens": 500,
                            "cache_creation_input_tokens": 20, "cache_read_input_tokens": 7},
                  "modelUsage": {
                    "claude-opus-5": {"inputTokens": 80, "outputTokens": 500,
                                      "cacheReadInputTokens": 100000, "cacheCreationInputTokens": 20},
                    "claude-haiku-4-5": {}
                  },
                  "total_cost_usd": 0.028029,
                  "num_turns": 9,
                  "duration_ms": 8163
                }
                """.trimIndent()
            )
        )
        assertEquals(80.0, summary?.usage?.inputTokens)
        assertEquals(500.0, summary?.usage?.outputTokens)
        assertEquals(20.0, summary?.usage?.cacheCreationInputTokens)
        assertEquals(7.0, summary?.usage?.cacheReadInputTokens)
        assertEquals(0.028029, summary?.totalCostUsd)
        assertEquals(9.0, summary?.numTurns)
        assertEquals(8163.0, summary?.durationMs)
        assertEquals(
            listOf("claude-opus-5", "claude-haiku-4-5"),
            summary?.modelUsage?.keys?.toList(),
        )
        assertEquals(100000.0, summary?.modelUsage?.get("claude-opus-5")?.cacheReadInputTokens)
    }

    @Test fun `usage requires whole non-negative input and output tokens`() {
        assertNull(normalizeRoundSummary(json("""{"usage": {"input_tokens": 80}}""")))
        assertNull(normalizeRoundSummary(json("""{"usage": {"input_tokens": 2.5, "output_tokens": 1}}""")))
        assertNull(normalizeRoundSummary(json("""{"usage": {"input_tokens": -1, "output_tokens": 1}}""")))
        // A broken usage does not take down the rest of the summary.
        val summary = normalizeRoundSummary(
            json("""{"usage": {"input_tokens": 80}, "num_turns": 3}""")
        )
        assertEquals(3.0, summary?.numTurns)
        assertNull(summary?.usage)
    }

    @Test fun `token-less model entries are kept while other models carry tokens`() {
        // Individual entries without valid counters survive (rendered as
        // plain model names); only a fully token-less map collapses.
        val summary = normalizeRoundSummary(
            json(
                """
                {"modelUsage": {
                  "claude-opus-5": {"outputTokens": 10},
                  "claude-haiku-4-5": {},
                  "claude-negative-5": {"inputTokens": -5}
                }}
                """.trimIndent()
            )
        )
        assertEquals(
            setOf("claude-opus-5", "claude-haiku-4-5", "claude-negative-5"),
            summary?.modelUsage?.keys,
        )
    }

    @Test fun `model usage collapses entirely when no model carries tokens`() {
        assertNull(normalizeRoundSummary(json("""{"modelUsage": {"a": {}, "b": {}}}""")))
    }

    @Test fun `zero cost and turn counts are dropped while fractional durations are kept`() {
        val summary = normalizeRoundSummary(
            json("""{"total_cost_usd": 0, "num_turns": 0, "duration_ms": 12.5}""")
        )
        assertNull(summary?.totalCostUsd)
        assertNull(summary?.numTurns)
        assertEquals(12.5, summary?.durationMs)
        // num_turns must be a whole count.
        assertNull(normalizeRoundSummary(json("""{"num_turns": 2.5}""")))
        assertNull(normalizeRoundSummary(json("""{"num_turns": -1}""")))
    }

    @Test fun `a summary with no usable signal decodes to null`() {
        assertNull(normalizeRoundSummary(null))
        assertNull(normalizeRoundSummary(json("""{}""")))
        assertNull(normalizeRoundSummary(json("""{"total_cost_usd": -1}""")))
    }

    // ------------------------------------------------------------------
    // Round trip through the synthesized event payload
    // ------------------------------------------------------------------

    @Test fun `a summary survives the event payload round trip`() {
        val original = RoundSummary(
            usage = UsageData(inputTokens = 80.0, outputTokens = 500.0, cacheReadInputTokens = 7.0),
            modelUsage = linkedMapOf(
                "claude-opus-5" to RoundModelUsage(inputTokens = 80.0, outputTokens = 500.0),
                "claude-haiku-4-5" to RoundModelUsage(),
            ),
            totalCostUsd = 0.028029,
            numTurns = 9.0,
            durationMs = 8163.0,
        )
        assertEquals(original, decodeRoundSummary(roundSummaryToJson(original)))
    }

    @Test fun `the event payload omits absent fields and carries provider and turn id`() {
        val payload = roundSummaryToJson(RoundSummary(provider = "codex", turnId = "t1", numTurns = 1.0))
        assertTrue("usage" !in payload)
        assertTrue("modelUsage" !in payload)
        assertTrue("totalCostUsd" !in payload)
        assertTrue("durationMs" !in payload)
        val decoded = decodeRoundSummary(payload)
        assertEquals("codex", decoded?.provider)
        assertEquals("t1", decoded?.turnId)
        assertEquals(1.0, decoded?.numTurns)
    }

    // ------------------------------------------------------------------
    // Claude turn_duration record
    // ------------------------------------------------------------------

    @Test fun `a claude turn duration with a result summary becomes a turn-summary event`() {
        val record = buildJsonObject {
            put("type", "output")
            put(
                "data",
                buildJsonObject {
                    put("type", "system")
                    put("subtype", "turn_duration")
                    put("durationMs", 8163.0)
                    put(
                        "resultSummary",
                        buildJsonObject {
                            put("total_cost_usd", 0.028029)
                            put("num_turns", 9)
                            put("duration_ms", 8163)
                        },
                    )
                },
            )
        }
        val message = normalizeAgentRecord("m1", null, 0, record, null)
        val event = assertIs<NormalizedMessage.Event>(message)
        val summary = assertIs<AgentEvent.TurnSummary>(event.event).summary
        assertEquals(0.028029, summary?.totalCostUsd)
        assertEquals(9.0, summary?.numTurns)
        assertEquals(8163.0, summary?.durationMs)
    }

    @Test fun `a claude turn duration without a result summary stays a duration event`() {
        val record = buildJsonObject {
            put("type", "output")
            put(
                "data",
                buildJsonObject {
                    put("type", "system")
                    put("subtype", "turn_duration")
                    put("durationMs", 4321.0)
                    put("messageId", "target-1")
                },
            )
        }
        val event = assertIs<NormalizedMessage.Event>(normalizeAgentRecord("m1", null, 0, record, null))
        val duration = assertIs<AgentEvent.TurnDuration>(event.event)
        assertEquals(4321.0, duration.durationMs)
        assertEquals("target-1", duration.targetMessageId)
    }

    // ------------------------------------------------------------------
    // Codex turn_duration gates
    // ------------------------------------------------------------------

    private fun codexTurnDuration(
        flavor: String? = "codex",
        turnId: String? = "t1",
        durationMs: Double? = 1500.0,
        scopeRole: String? = null,
        nestedScopeRole: String? = null,
        usageScope: String? = null,
    ): JsonElement = buildJsonObject {
        put("type", "codex")
        put(
            "data",
            buildJsonObject {
                put("type", "turn_duration")
                flavor?.let { put("flavor", it) }
                turnId?.let { put("turn_id", it) }
                durationMs?.let { put("durationMs", it) }
                scopeRole?.let { put("scope_role", it) }
                usageScope?.let { put("hapiUsageScope", it) }
                nestedScopeRole?.let { role -> put("scope", buildJsonObject { put("role", role) }) }
            },
        )
    }

    @Test fun `a top-level native turn duration becomes a provider event with stamped meta`() {
        val message = normalizeAgentRecord("m1", null, 0, codexTurnDuration(), null)
        val event = assertIs<NormalizedMessage.Event>(message)
        val duration = assertIs<AgentEvent.TurnDuration>(event.event)
        assertEquals("codex", duration.provider)
        assertEquals("t1", duration.turnId)
        assertEquals(1500.0, duration.durationMs)
        assertEquals("t1", asString(assertIs<JsonObject>(event.meta)["codexTurnId"]))
    }

    @Test fun `imported history and child scopes are not billable round signals`() {
        assertNull(
            normalizeAgentRecord("m1", null, 0, codexTurnDuration(usageScope = "imported-history"), null)
        )
        assertNull(normalizeAgentRecord("m1", null, 0, codexTurnDuration(scopeRole = "child"), null))
        assertNull(normalizeAgentRecord("m1", null, 0, codexTurnDuration(nestedScopeRole = "child"), null))
    }

    @Test fun `native turn durations need the codex flavor, a turn id and a valid duration`() {
        assertNull(normalizeAgentRecord("m1", null, 0, codexTurnDuration(flavor = null), null))
        assertNull(normalizeAgentRecord("m1", null, 0, codexTurnDuration(turnId = null), null))
        assertNull(normalizeAgentRecord("m1", null, 0, codexTurnDuration(durationMs = -5.0), null))
        // Fractional durations are valid.
        val event = assertIs<NormalizedMessage.Event>(
            normalizeAgentRecord("m1", null, 0, codexTurnDuration(durationMs = 1.5), null)
        )
        assertEquals(1.5, assertIs<AgentEvent.TurnDuration>(event.event).durationMs)
    }

    // ------------------------------------------------------------------
    // token_count provider stamping
    // ------------------------------------------------------------------

    private fun tokenCount(flavor: String?): JsonElement = buildJsonObject {
        put("type", "codex")
        put(
            "data",
            buildJsonObject {
                put("type", "token_count")
                flavor?.let { put("flavor", it) }
                put("turn_id", "t1")
                put("model", "gpt-5.4")
                put(
                    "info",
                    buildJsonObject {
                        put(
                            "last",
                            buildJsonObject {
                                put("inputTokens", 100)
                                put("outputTokens", 10)
                            },
                        )
                    },
                )
            },
        )
    }

    @Test fun `codex token counts stamp provider, turn id and model`() {
        val message = normalizeAgentRecord("m1", null, 0, tokenCount("codex"), null)
        val event = assertIs<NormalizedMessage.Event>(message)
        assertEquals(100.0, event.usage?.inputTokens)
        assertEquals(10.0, event.usage?.outputTokens)
        assertEquals("codex", asString(event.event.raw["provider"]))
        assertEquals("t1", asString(event.event.raw["turnId"]))
        assertEquals("gpt-5.4", asString(event.event.raw["model"]))
    }

    @Test fun `other token count flavors carry no provider`() {
        val message = normalizeAgentRecord("m1", null, 0, tokenCount("cli"), null)
        val event = assertIs<NormalizedMessage.Event>(message)
        assertTrue("provider" !in event.event.raw)
        assertTrue("turnId" !in event.event.raw)
        assertTrue("model" !in event.event.raw)
    }

    // ------------------------------------------------------------------
    // attach rules (merge semantics)
    // ------------------------------------------------------------------

    private fun block(
        id: String,
        meta: JsonObject? = null,
        roundSummary: RoundSummary? = null,
    ) = AgentTextBlock(
        id = id, localId = null, createdAt = 0, invokedAt = null,
        usage = null, model = null, roundSummary = roundSummary,
        text = "t-$id", meta = meta,
    )

    private fun stampedMeta(turnId: String) = buildJsonObject { put("codexTurnId", turnId) }

    @Test fun `a summary attaches onto the block stamped with its turn id`() {
        val b = block("a", meta = stampedMeta("t1"))
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(b),
            RoundSummary(provider = "codex", turnId = "t1", usage = UsageData(1.0, 2.0), numTurns = 1.0),
        )
        assertEquals("t1", b.roundSummary?.turnId)
        assertEquals(1.0, b.roundSummary?.usage?.inputTokens)
    }

    @Test fun `a duration merge keeps the usage and model usage of the previous merge`() {
        val b = block(
            "a", meta = stampedMeta("t1"),
            roundSummary = RoundSummary(
                provider = "codex", turnId = "t1",
                usage = UsageData(100.0, 10.0),
                modelUsage = linkedMapOf("gpt-5.4" to RoundModelUsage(100.0, 10.0)),
                numTurns = 1.0,
            ),
        )
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(b),
            RoundSummary(provider = "codex", turnId = "t1", modelUsage = linkedMapOf(), numTurns = 1.0, durationMs = 5000.0),
        )
        assertEquals(100.0, b.roundSummary?.usage?.inputTokens)
        assertEquals(10.0, b.roundSummary?.modelUsage?.get("gpt-5.4")?.outputTokens)
        assertEquals(5000.0, b.roundSummary?.durationMs)
        assertEquals(1.0, b.roundSummary?.numTurns)
    }

    @Test fun `an unmatched turn id without usage attaches nothing`() {
        val b = block("a", meta = stampedMeta("t1"))
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(b),
            RoundSummary(provider = "codex", turnId = "tX", numTurns = 1.0, durationMs = 100.0),
        )
        assertNull(b.roundSummary)
    }

    @Test fun `summaries without turn ids fall back to the trailing group`() {
        val a = block("a")
        val b = block("b")
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(a, b),
            RoundSummary(provider = "codex", usage = UsageData(1.0, 2.0), numTurns = 1.0),
        )
        assertEquals(1.0, a.roundSummary?.usage?.inputTokens)
        assertNull(b.roundSummary)
    }

    @Test fun `the fallback is blocked when the trailing group holds a stamped block`() {
        val a = block("a")
        val b = block("b", meta = stampedMeta("t9"))
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(a, b),
            RoundSummary(provider = "codex", turnId = "tX", usage = UsageData(1.0, 2.0), numTurns = 1.0),
        )
        assertNull(a.roundSummary)
        assertNull(b.roundSummary)
    }

    @Test fun `a summary for a newer turn does not clobber an older turn's summary`() {
        val a = block(
            "a", meta = stampedMeta("t1"),
            roundSummary = RoundSummary(provider = "codex", turnId = "t1", totalCostUsd = 0.5),
        )
        val b = block("b", meta = stampedMeta("t2"))
        val c = block("c", meta = stampedMeta("t1"))
        attachCodexRoundSummaryToLatestGroup(
            mutableListOf<ChatBlock>(a, b, c),
            RoundSummary(provider = "codex", turnId = "t2", usage = UsageData(9.0, 9.0), numTurns = 1.0),
        )
        assertEquals("t1", a.roundSummary?.turnId)
        assertEquals(0.5, a.roundSummary?.totalCostUsd)
        assertNull(b.roundSummary)
    }

    // ------------------------------------------------------------------
    // End-to-end reduction
    // ------------------------------------------------------------------

    @Test fun `a claude turn summary attaches to the first block of the trailing group`() {
        val summary = roundSummaryToJson(
            RoundSummary(totalCostUsd = 0.02, numTurns = 4.0, durationMs = 3000.0)
        )
        val reduced = reduceChatBlocks(
            listOf(
                NormalizedMessage.Agent(
                    id = "a1", localId = null, createdAt = 0,
                    content = listOf(NormalizedAgentContent.Text("hello", uuid = "u1")),
                ),
                NormalizedMessage.Event(
                    id = "e1", localId = null, createdAt = 1,
                    event = AgentEvent.of(
                        buildJsonObject {
                            put("type", "turn-summary")
                            put("summary", summary)
                        }
                    ),
                ),
            ),
            null,
        )
        val block = assertIs<AgentTextBlock>(reduced.blocks.single())
        assertEquals(0.02, block.roundSummary?.totalCostUsd)
        assertEquals(4.0, block.roundSummary?.numTurns)
        assertEquals(3000.0, block.roundSummary?.durationMs)
    }

    @Test fun `codex token counts and turn durations merge into one summary`() {
        val meta = stampedMeta("t1")
        val reduced = reduceChatBlocks(
            listOf(
                NormalizedMessage.Agent(
                    id = "a1", localId = null, createdAt = 0,
                    content = listOf(NormalizedAgentContent.Text("hi", uuid = "u1")),
                    meta = meta,
                ),
                NormalizedMessage.Event(
                    id = "e1", localId = null, createdAt = 1,
                    event = AgentEvent.of(
                        buildJsonObject {
                            put("type", "token-count")
                            put("provider", "codex")
                            put("turnId", "t1")
                            put("model", "gpt-5.4")
                        }
                    ),
                    usage = UsageData(inputTokens = 100.0, outputTokens = 10.0),
                ),
                NormalizedMessage.Event(
                    id = "e2", localId = null, createdAt = 2,
                    event = AgentEvent.of(
                        buildJsonObject {
                            put("type", "turn-duration")
                            put("provider", "codex")
                            put("durationMs", 2500.0)
                            put("turnId", "t1")
                        }
                    ),
                ),
            ),
            null,
        )
        val block = assertIs<AgentTextBlock>(reduced.blocks.single())
        val summary = block.roundSummary
        assertEquals(100.0, summary?.usage?.inputTokens)
        assertEquals(10.0, summary?.modelUsage?.get("gpt-5.4")?.outputTokens)
        assertEquals(2500.0, summary?.durationMs)
        assertEquals(1.0, summary?.numTurns)
    }

    @Test fun `child-scope token counts do not attach`() {
        val meta = stampedMeta("t1")
        val reduced = reduceChatBlocks(
            listOf(
                NormalizedMessage.Agent(
                    id = "a1", localId = null, createdAt = 0,
                    content = listOf(NormalizedAgentContent.Text("hi", uuid = "u1")),
                    meta = meta,
                ),
                NormalizedMessage.Event(
                    id = "e1", localId = null, createdAt = 1,
                    event = AgentEvent.of(
                        buildJsonObject {
                            put("type", "token-count")
                            put("provider", "codex")
                            put("turnId", "t1")
                        }
                    ),
                    usage = UsageData(inputTokens = 100.0, outputTokens = 10.0, scopeRole = "child"),
                ),
            ),
            null,
        )
        assertNull(assertIs<AgentTextBlock>(reduced.blocks.single()).roundSummary)
    }

    @Test fun `a tool use restamped with a new turn id drops the previous summary`() {
        fun toolUse(id: String, uuid: String, turnId: String) = NormalizedMessage.Agent(
            id = id, localId = null, createdAt = 0,
            content = listOf(
                NormalizedAgentContent.ToolUse(
                    id = "tool-1", name = "Read", input = null, description = null, uuid = uuid,
                )
            ),
            meta = stampedMeta(turnId),
        )

        val reduced = reduceChatBlocks(
            listOf(
                toolUse("a1", "u1", "t1"),
                NormalizedMessage.Event(
                    id = "e1", localId = null, createdAt = 1,
                    event = AgentEvent.of(
                        buildJsonObject {
                            put("type", "token-count")
                            put("provider", "codex")
                            put("turnId", "t1")
                        }
                    ),
                    usage = UsageData(inputTokens = 100.0, outputTokens = 10.0),
                ),
                toolUse("a2", "u2", "t2"),
            ),
            null,
        )
        val block = assertIs<ToolCallBlock>(reduced.blocks.single())
        assertNull(block.roundSummary)
        assertEquals("t2", asString(assertIs<JsonObject>(block.meta)["codexTurnId"]))
    }
}

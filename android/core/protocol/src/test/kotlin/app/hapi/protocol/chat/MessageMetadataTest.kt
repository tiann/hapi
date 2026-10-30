package app.hapi.protocol.chat

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Label contract of the per-message metadata popup. Every case pins the
 * exact rendered lines (ordering, separators, number formatting) so a
 * formatting regression surfaces as a byte-level diff.
 */
class MessageMetadataTest {

    private fun usage(input: Double, output: Double, tier: String? = null) = UsageData(
        inputTokens = input,
        outputTokens = output,
        serviceTier = tier,
    )

    @Test fun `renders Model label with the per-message model name`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(model = "claude-sonnet-4-6", usage = usage(3.0, 15.0, "standard"))
        )
        assertTrue("Model: claude-sonnet-4-6" in parts, parts.toString())
    }

    @Test fun `does not render service tier as the model when model is missing`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(usage = usage(3.0, 15.0, "priority"))
        )
        // The tier value (e.g. "priority", "standard_only") must never be
        // surfaced as the model id.
        assertFalse("Model: priority" in parts, parts.toString())
        assertTrue(parts.none { it.startsWith("Model:") }, parts.toString())
        assertTrue("Tier: priority" in parts, parts.toString())
    }

    @Test fun `omits both Model and Tier labels when service tier is the default standard`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(usage = usage(3.0, 15.0, "standard"))
        )
        assertTrue(parts.none { it.startsWith("Model:") }, parts.toString())
        assertTrue(parts.none { it.startsWith("Tier:") }, parts.toString())
    }

    @Test fun `appends non-standard service tier in parentheses next to the model id`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(model = "claude-sonnet-4-6", usage = usage(3.0, 15.0, "priority"))
        )
        assertTrue("Model: claude-sonnet-4-6 (priority)" in parts, parts.toString())
    }

    @Test fun `returns an empty list when nothing is provided`() {
        assertEquals(emptyList(), buildMessageMetadataLabels(MessageMetadataInput()))
    }

    @Test fun `renders the token total and breakdown without billing claims`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(usage = usage(100.0, 200.0))
        )
        assertTrue("Tokens: 300 total (100 in / 200 out)" in parts, parts.toString())
        assertTrue(parts.none { Regex("\\bbillable\\b").containsMatchIn(it) }, parts.toString())
    }

    @Test fun `does not drop a Duration line when durationMs is exactly zero`() {
        val parts = buildMessageMetadataLabels(MessageMetadataInput(durationMs = 0.0))
        assertTrue("Duration: 0.0s" in parts, parts.toString())
    }

    @Test fun `uses compact units for long legacy durations`() {
        assertTrue(
            "Duration: 1m" in buildMessageMetadataLabels(MessageMetadataInput(durationMs = 60_000.0)),
        )
        assertTrue(
            "Duration: 1h" in buildMessageMetadataLabels(MessageMetadataInput(durationMs = 3_600_000.0)),
        )
    }

    // Invariance proof — single-turn inputs (turnCount omitted, or < 2) must
    // produce byte-identical output so existing single-turn cards do not
    // regress visually.
    @Test fun `single-turn input is byte-identical with or without turnCount of one`() {
        val base = MessageMetadataInput(
            durationMs = 1234.0,
            model = "claude-sonnet-4-6",
            usage = usage(3.0, 19.0, "standard"),
        )
        val withoutTurn = buildMessageMetadataLabels(base)
        val withTurnOne = buildMessageMetadataLabels(base.copy(turnCount = 1))
        assertEquals(withoutTurn, withTurnOne)
    }

    @Test fun `single-turn call produces the exact label sequence`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(
                durationMs = 1234.0,
                model = "claude-sonnet-4-6",
                usage = usage(3.0, 19.0, "standard"),
            )
        )
        assertEquals(
            listOf(
                "Duration: 1.2s",
                "Model: claude-sonnet-4-6",
                "Tokens: 22 total (3 in / 19 out)",
            ),
            parts,
        )
    }

    @Test fun `switches to Models and turns labels only when turnCount is at least two`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(
                model = "claude-sonnet-4-6, claude-haiku-4-5-20251001",
                usage = usage(100.0, 200.0, "standard"),
                turnCount = 3,
            )
        )
        assertTrue("Models: claude-sonnet-4-6, claude-haiku-4-5-20251001" in parts, parts.toString())
        assertTrue(parts.none { it.startsWith("Model:") }, parts.toString())
        assertTrue("Tokens: 300 total (100 in / 200 out)" in parts, parts.toString())
        assertTrue("3 turns" in parts, parts.toString())
    }

    @Test fun `keeps the singular Model label when an aggregated group has only one distinct model`() {
        // Mid-session model switch is rare; the common multi-turn case is one
        // model repeated across N turns. The label must stay singular then.
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(
                model = "claude-sonnet-4-6",
                usage = usage(10.0, 20.0, "standard"),
                turnCount = 2,
            )
        )
        assertTrue("Model: claude-sonnet-4-6" in parts, parts.toString())
        assertTrue(parts.none { it.startsWith("Models:") }, parts.toString())
        assertTrue("2 turns" in parts, parts.toString())
    }

    @Test fun `omits Duration on aggregated footers when durationMs is undefined`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(
                model = "claude-sonnet-4-6, claude-haiku-4-5-20251001",
                usage = usage(10.0, 20.0, "standard"),
                turnCount = 2,
            )
        )
        assertTrue(parts.none { it.startsWith("Duration:") }, parts.toString())
    }

    @Test fun `renders the exact round summary hierarchy`() {
        val parts = buildMessageMetadataLabels(
            MessageMetadataInput(
                model = "derived-model-that-must-not-win",
                usage = usage(1.0, 1.0),
                roundSummary = RoundSummary(
                    modelUsage = linkedMapOf(
                        "claude-opus-5" to RoundModelUsage(
                            inputTokens = 80.0,
                            cacheCreationInputTokens = 20.0,
                            cacheReadInputTokens = 100_000.0,
                            outputTokens = 500.0,
                        ),
                        "claude-haiku-4-5" to RoundModelUsage(),
                    ),
                    totalCostUsd = 0.028029,
                    numTurns = 9.0,
                    durationMs = 8163.0,
                ),
            )
        )
        assertEquals(
            listOf(
                "Models: claude-opus-5, claude-haiku-4-5",
                "Tokens: 100.6k (100.1k in · 500 out)",
                "Cached input: 99.9% · Cost: \$0.028",
                "Round: 8.2s · 9 turns",
            ),
            parts,
        )
    }

    @Test fun `formats long round durations with minutes and hours`() {
        fun summary(durationMs: Double) = buildMessageMetadataLabels(
            MessageMetadataInput(
                roundSummary = RoundSummary(
                    modelUsage = emptyMap(),
                    durationMs = durationMs,
                    numTurns = 1.0,
                )
            )
        )

        assertTrue("Round: 59.9s · 1 turn" in summary(59_900.0), summary(59_900.0).toString())
        assertTrue("Round: 1m · 1 turn" in summary(60_000.0), summary(60_000.0).toString())
        assertTrue("Round: 8m 57s · 1 turn" in summary(537_000.0), summary(537_000.0).toString())
        assertTrue("Round: 1h 1m 1s · 1 turn" in summary(3_661_000.0), summary(3_661_000.0).toString())
    }

    @Test fun `labels a top-level codex turn with Round`() {
        assertEquals(
            listOf(
                "Model: gpt-5.4",
                "Tokens: 110 (100 in · 10 out)",
                "Round: 1 turn",
            ),
            buildMessageMetadataLabels(
                MessageMetadataInput(
                    roundSummary = RoundSummary(
                        provider = "codex",
                        modelUsage = linkedMapOf(
                            "gpt-5.4" to RoundModelUsage(inputTokens = 100.0, outputTokens = 10.0),
                        ),
                        numTurns = 1.0,
                    )
                )
            ),
        )
    }

    @Test fun `keeps the existing formatter byte-identical when no result summary is present`() {
        assertEquals(
            listOf(
                "Duration: 1.2s",
                "Model: claude-sonnet-4-6",
                "Tokens: 22 total (3 in / 19 out)",
            ),
            buildMessageMetadataLabels(
                MessageMetadataInput(
                    durationMs = 1234.0,
                    model = "claude-sonnet-4-6",
                    usage = usage(3.0, 19.0, "standard"),
                )
            ),
        )
    }

    @Test fun `uses the normalized valid model fields when other model counters are absent`() {
        assertEquals(
            listOf(
                "Models: claude-opus-5, claude-haiku-4-5, claude-empty-5",
                "Tokens: 24 (10 in · 14 out)",
                "Cost: <\$0.0001",
                "Round: 0.0s",
            ),
            buildMessageMetadataLabels(
                MessageMetadataInput(
                    roundSummary = RoundSummary(
                        modelUsage = linkedMapOf(
                            "claude-opus-5" to RoundModelUsage(outputTokens = 10.0),
                            "claude-haiku-4-5" to RoundModelUsage(inputTokens = 10.0, outputTokens = 4.0),
                            "claude-empty-5" to RoundModelUsage(),
                        ),
                        totalCostUsd = 0.00002,
                        durationMs = 12.5,
                    )
                )
            ),
        )
    }
}

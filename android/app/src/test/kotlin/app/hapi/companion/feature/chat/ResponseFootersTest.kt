package app.hapi.companion.feature.chat

import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.CliOutputBlock
import app.hapi.protocol.chat.CodexReview
import app.hapi.protocol.chat.CodexReviewFinding
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

class ResponseFootersTest {
    private fun user(id: String, at: Long = 0) = UserTextBlock(id, null, at, null, "hi", null, null, null, null)
    private fun text(id: String, body: String, at: Long = 0, model: String? = null) =
        AgentTextBlock(id = id, localId = null, createdAt = at, invokedAt = null, model = model, text = body, meta = null)
    private fun reasoning(id: String, at: Long = 0) =
        AgentReasoningBlock(id = id, localId = null, createdAt = at, invokedAt = null, text = "thinking", meta = null)
    private fun cli(id: String, source: String, body: String, at: Long = 0) =
        CliOutputBlock(id = id, localId = null, createdAt = at, invokedAt = null, text = body, source = source, meta = null)

    private fun footers(vararg blocks: VisibleChatBlock) = buildResponseFooters(blocks.toList(), emptyMap())

    @Test fun `one footer per response, under its last block`() {
        val result = footers(
            user("u1"), reasoning("r1"), text("a1", "first"), previewToolCall("t1", "Bash"), text("a2", "second"),
            user("u2"), text("a3", "third"),
        )
        assertEquals(setOf("a2", "a3"), result.keys)
    }

    @Test fun `user-source CLI output is a boundary, assistant CLI output joins the response`() {
        val result = footers(text("a1", "x"), cli("c1", "user", "$ ls"), cli("c2", "assistant", "out"))
        assertEquals(setOf("a1", "c2"), result.keys)
        assertEquals("out", result.getValue("c2").copyText)
    }

    @Test fun `copy joins trimmed prose with a blank line and skips reasoning and tools`() {
        val result = footers(reasoning("r1"), text("a1", "  first \n"), previewToolCall("t1", "Bash"), text("a2", "second"))
        assertEquals("first\n\nsecond", result.getValue("a2").copyText)
    }

    @Test fun `tool-only responses have no copy text`() {
        val result = footers(user("u1"), previewToolCall("t1", "Bash"))
        assertNull(result.getValue("t1").copyText)
    }

    @Test fun `details come from the first block with usage labels`() {
        val withModel = text("a2", "second", model = "claude-opus")
        val result = footers(text("a1", "first"), withModel)
        assertSame(withModel, result.getValue("a2").detailsBlock)
        assertNull(footers(text("a1", "first")).getValue("a1").detailsBlock)
    }

    @Test fun `timestamp is the response's latest activity`() {
        val result = footers(text("a1", "x", at = 300), reasoning("r1", at = 100), text("a2", "y", at = 200))
        assertEquals(300, result.getValue("a2").timestamp)
    }

    @Test fun `codex review copy matches the web formatter`() {
        val review = CodexReview(
            findings = listOf(
                CodexReviewFinding("Null deref", "Guard it.", 1.0, null, "src/a.ts", 12.0, 14.0),
                CodexReviewFinding("Typo", "Fix spelling.", null, null, "README.md", 3.0, 3.0),
            ),
            overallCorrectness = "patch is incorrect",
            overallExplanation = "One crash.",
            overallConfidenceScore = null,
        )
        assertEquals(
            "Codex review\nOverall: patch is incorrect\n\nOne crash.\n\nFindings:\n" +
                "- [P1] Null deref (src/a.ts:12-14)\n  Guard it.\n- Typo (README.md:3)\n  Fix spelling.",
            formatCodexReviewText(review),
        )
    }

    @Test fun `timestamp skeleton follows the web day and year rules`() {
        val zone = ZoneId.of("Asia/Shanghai")
        fun at(text: String) = LocalDateTime.parse(text).atZone(zone).toInstant().toEpochMilli()
        val now = at("2026-11-13T09:00:00")
        assertEquals(MessageTimestampSkeleton.TIME, messageTimestampSkeleton(at("2026-11-13T00:05:00"), now, zone))
        assertEquals(MessageTimestampSkeleton.MONTH_DAY, messageTimestampSkeleton(at("2026-11-12T23:59:00"), now, zone))
        assertEquals(MessageTimestampSkeleton.FULL, messageTimestampSkeleton(at("2025-12-31T23:59:00"), now, zone))
    }
}

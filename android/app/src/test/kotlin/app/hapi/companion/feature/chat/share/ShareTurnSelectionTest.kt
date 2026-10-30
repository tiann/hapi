package app.hapi.companion.feature.chat.share

import app.hapi.companion.feature.chat.stableId
import app.hapi.protocol.chat.AgentEvent
import app.hapi.protocol.chat.AgentEventBlock
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.CliOutputBlock
import app.hapi.protocol.chat.CodexReview
import app.hapi.protocol.chat.CodexReviewBlock
import app.hapi.protocol.chat.GeneratedImageBlock
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.UserTextBlock
import app.hapi.protocol.chat.VisibleChatBlock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ShareTurnSelectionTest {

    private fun user(id: String, text: String = "question-$id") =
        UserTextBlock(id, null, 0, null, text, null, null, null, null)

    private fun agent(id: String, text: String = "answer-$id") =
        AgentTextBlock(id, null, 0, null, null, null, null, null, text, null)

    private fun reasoning(id: String, text: String = "thinking-$id") =
        AgentReasoningBlock(id, null, 0, null, null, null, null, null, text, null)

    private fun cliOutput(id: String, text: String, source: String) =
        CliOutputBlock(id, null, 0, null, null, null, null, null, text, source, null)

    private fun toolCall(id: String) = ToolCallBlock(
        id, null, 0, null, null, null, null, null,
        ChatToolCall(id, "Read", "completed", null, 0, description = null),
        emptyList(), null,
    )

    private fun generatedImage(id: String, fileName: String = "card.png") = GeneratedImageBlock(
        id, null, 0, null, id, fileName, "image/png", null, null, null,
    )

    private fun review(id: String) = CodexReviewBlock(
        id, null, 0, null, null, null, null, null,
        CodexReview(findings = emptyList(), overallCorrectness = null, overallExplanation = "looks fine", overallConfidenceScore = null),
        null,
    )

    private fun event(id: String) =
        AgentEventBlock(id, 0, null, null, AgentEvent.Custom(buildJsonObject { put("type", "message") }), null)

    private fun ids(blocks: List<VisibleChatBlock>) = blocks.map { it.stableId }

    // ------------------------------------------------------ turn boundary --

    @Test fun assistantTargetSelectsItsOwnTurn() {
        val blocks = listOf(user("u1"), agent("a1"), user("u2"), agent("a2"))
        assertEquals(listOf("u2", "a2"), ids(ShareTurnSelection.selectTurnBlocks(blocks, blocks[3])))
    }

    @Test fun earlierAssistantTurnIsReachable() {
        val blocks = listOf(user("u1"), agent("a1"), user("u2"), agent("a2"))
        assertEquals(listOf("u1", "a1"), ids(ShareTurnSelection.selectTurnBlocks(blocks, blocks[1])))
    }

    @Test fun userTargetStartsTheTurnAtItself() {
        val blocks = listOf(user("u1"), agent("a1"), user("u2"), agent("a2"))
        assertEquals(listOf("u2", "a2"), ids(ShareTurnSelection.selectTurnBlocks(blocks, blocks[2])))
    }

    @Test fun targetWithoutEarlierUserStartsAtTarget() {
        val blocks = listOf(agent("a0"), agent("a1"))
        assertEquals(listOf("a1"), ids(ShareTurnSelection.selectTurnBlocks(blocks, blocks[1])))
    }

    @Test fun userSourcedCliOutputStartsATurn() {
        val blocks = listOf(user("u1"), agent("a1"), cliOutput("c1", "$ command", "user"), agent("a2"))
        assertEquals(listOf("c1", "a2"), ids(ShareTurnSelection.selectTurnBlocks(blocks, blocks[3])))
    }

    @Test fun missingTargetFallsBackToTheTargetBlock() {
        val blocks = listOf(user("u1"), agent("a1"))
        val outsider = agent("zzz")
        assertEquals(listOf("zzz"), ids(ShareTurnSelection.selectTurnBlocks(blocks, outsider)))
    }

    // ------------------------------------------------- shareable content --

    @Test fun segmentsDropThinkingToolActivityAndEvents() {
        val blocks = listOf(
            user("u1", "what happened?"),
            reasoning("r1"),
            toolCall("t1"),
            event("e1"),
            agent("a1", "this happened"),
        )
        val segments = ShareTurnSelection.shareableSegments(blocks)
        assertEquals(listOf("user" to "what happened?", "assistant" to "this happened"), segments.map { it.role to it.text })
    }

    @Test fun segmentsKeepThreadOrderAndCarryKinds() {
        val blocks = listOf(
            cliOutput("c0", "past output", "user"),
            user("u1", "draw something"),
            agent("a1", "here you go"),
            generatedImage("g1", "drawing.png"),
            cliOutput("c2", "assistant-side log", "assistant"),
            review("rv1"),
        )
        val segments = ShareTurnSelection.shareableSegments(blocks)
        assertEquals(
            listOf(
                "user" to ShareTurnSegmentKind.TEXT,
                "user" to ShareTurnSegmentKind.TEXT,
                "assistant" to ShareTurnSegmentKind.TEXT,
                "assistant" to ShareTurnSegmentKind.MEDIA,
                "assistant" to ShareTurnSegmentKind.TEXT,
                "assistant" to ShareTurnSegmentKind.TEXT,
            ),
            segments.map { it.role to it.kind },
        )
        assertEquals("🖼 drawing.png", segments[3].text)
        assertTrue(segments[5].text.contains("looks fine"))
    }

    @Test fun blankTextsProduceNoSegment() {
        val blocks = listOf(user("u1", "   "), agent("a1", ""))
        assertTrue(ShareTurnSelection.shareableSegments(blocks).isEmpty())
    }

    @Test fun plainTextJoinsSegmentsWithBlankLines() {
        val segments = listOf(
            ShareTurnSegment("user", ShareTurnSegmentKind.TEXT, "question"),
            ShareTurnSegment("assistant", ShareTurnSegmentKind.TEXT, "answer"),
        )
        assertEquals("question\n\nanswer", ShareTurnSelection.plainText(segments))
    }

    // -------------------------------------------------------- anchoring --

    @Test fun onlyContentBlocksCanAnchorAShare() {
        assertTrue(ShareTurnSelection.canAnchorShareTurn(user("u1")))
        assertTrue(ShareTurnSelection.canAnchorShareTurn(agent("a1")))
        assertTrue(ShareTurnSelection.canAnchorShareTurn(cliOutput("c1", "x", "user")))
        assertTrue(ShareTurnSelection.canAnchorShareTurn(generatedImage("g1")))
        assertTrue(ShareTurnSelection.canAnchorShareTurn(review("rv1")))
        assertFalse(ShareTurnSelection.canAnchorShareTurn(reasoning("r1")))
        assertFalse(ShareTurnSelection.canAnchorShareTurn(toolCall("t1")))
        assertFalse(ShareTurnSelection.canAnchorShareTurn(event("e1")))
    }
}

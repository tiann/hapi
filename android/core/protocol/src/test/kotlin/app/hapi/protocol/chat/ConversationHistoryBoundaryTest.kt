package app.hapi.protocol.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * [findLatestCompletedBoundaryKey] — the fork-boundary port of the web's
 * `findLatestCompletedBoundaryId`. Cases mirror the web semantics: invoked
 * user turns and assistant-run starts are boundaries; the active turn is
 * excluded while running; system events split assistant runs; tool groups
 * can head an assistant run (their key never matches a text row, so the
 * preceding user row falls back to "fork from here" — web parity).
 */
class ConversationHistoryBoundaryTest {

    private fun user(id: String, at: Long, invoked: Boolean = true) = UserTextBlock(
        id = id,
        localId = "local-$id",
        createdAt = at,
        invokedAt = if (invoked) at else null,
        text = "prompt $id",
        attachments = null,
        status = null,
        originalText = null,
        meta = null,
    )

    private fun agent(id: String, at: Long) = AgentTextBlock(
        id = id,
        localId = "local-$id",
        createdAt = at,
        invokedAt = at,
        text = "answer $id",
        meta = null,
    )

    private fun toolGroup(id: String, at: Long) = ToolGroupBlock(
        id = id,
        createdAt = at,
        invokedAt = at,
        firstToolId = "tool-1",
        lastToolId = "tool-1",
        tools = emptyList(),
        defaultOpen = false,
        historyState = "complete",
        needsOlderHistory = false,
        activityTitle = null,
        presentationMode = "default",
        summary = ToolGroupSummary(
            totalTools = 0,
            countsByKind = emptyMap(),
            fileTargets = emptyList(),
            commandTargets = emptyList(),
            searchTargets = emptyList(),
            urlTargets = emptyList(),
            otherTargets = emptyList(),
            errorCount = 0,
            runningCount = 0,
            pendingCount = 0,
        ),
    )

    private fun systemEvent(id: String, at: Long) = AgentEventBlock(
        id = id,
        createdAt = at,
        invokedAt = at,
        model = null,
        event = AgentEvent.Switch(raw = buildJsonObject { put("type", "agent_switch") }),
        meta = null,
    )

    @Test
    fun `latest boundary is the head of the last assistant run when idle`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), user("u2", 300), agent("a2", 400))
        assertEquals("agent-text:a2", findLatestCompletedBoundaryKey(blocks, isRunning = false, activeTurnStartedAt = null))
    }

    @Test
    fun `consecutive assistant blocks are one run - only the first is a boundary`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), agent("a2", 300))
        assertEquals("agent-text:a1", findLatestCompletedBoundaryKey(blocks, isRunning = false, activeTurnStartedAt = null))
    }

    @Test
    fun `a queued user message is not a boundary`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), user("u2", 300, invoked = false))
        assertEquals("agent-text:a1", findLatestCompletedBoundaryKey(blocks, isRunning = false, activeTurnStartedAt = null))
    }

    @Test
    fun `invoked user turn alone is a boundary`() {
        assertEquals(
            "user-text:u1",
            findLatestCompletedBoundaryKey(listOf(user("u1", 100)), isRunning = false, activeTurnStartedAt = null),
        )
    }

    @Test
    fun `running excludes the active turn via the timestamp`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), user("u2", 300), agent("a2", 400))
        assertEquals(
            "agent-text:a1",
            findLatestCompletedBoundaryKey(blocks, isRunning = true, activeTurnStartedAt = 300),
        )
    }

    @Test
    fun `running without a timestamp limits at the last invoked user turn`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), user("u2", 300), agent("a2", 400))
        assertEquals(
            "agent-text:a1",
            findLatestCompletedBoundaryKey(blocks, isRunning = true, activeTurnStartedAt = null),
        )
    }

    @Test
    fun `running without a timestamp and without an invoked user turn yields null`() {
        assertNull(
            findLatestCompletedBoundaryKey(listOf(agent("a1", 100)), isRunning = true, activeTurnStartedAt = null),
        )
    }

    @Test
    fun `timestamped running falls back to the first active block when no user matches`() {
        // u1 (100) predates the turn marker (250); a1 (200) too; a2 (300) is
        // the first block of the active turn → the scan stops before it.
        val blocks = listOf(user("u1", 100), agent("a1", 200), agent("a2", 300))
        assertEquals(
            "agent-text:a1",
            findLatestCompletedBoundaryKey(blocks, isRunning = true, activeTurnStartedAt = 250),
        )
    }

    @Test
    fun `tool groups can head an assistant run`() {
        val blocks = listOf(user("u1", 100), toolGroup("g1", 200), agent("a1", 300))
        assertEquals(
            "tool-group:g1",
            findLatestCompletedBoundaryKey(blocks, isRunning = false, activeTurnStartedAt = null),
        )
    }

    @Test
    fun `system events split assistant runs`() {
        val blocks = listOf(user("u1", 100), agent("a1", 200), systemEvent("e1", 250), agent("a2", 300))
        assertEquals(
            "agent-text:a2",
            findLatestCompletedBoundaryKey(blocks, isRunning = false, activeTurnStartedAt = null),
        )
    }

    @Test
    fun `empty transcript yields null`() {
        assertNull(findLatestCompletedBoundaryKey(emptyList(), isRunning = false, activeTurnStartedAt = null))
    }

    @Test
    fun `thread key is kind-colon-id for both block families`() {
        assertEquals("user-text:u9", user("u9", 1).threadKey)
        assertEquals("tool-group:g9", toolGroup("g9", 1).threadKey)
    }
}

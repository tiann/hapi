package app.hapi.companion.feature.chat

import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.protocol.chat.*
import kotlin.test.*
import kotlinx.serialization.json.JsonPrimitive

class ChatInspectionStateTest {
    private fun tool(id: String, output: String = "first", state: String = "running") =
        previewToolCall(id, "Read", state = state, input = mapOf("file_path" to "/repo/$id.kt")).also {
            it.tool = it.tool.copy(result = JsonPrimitive(output))
        }

    private fun group(tools: List<ToolCallBlock>) = buildVisibleChatBlocks(
        tools, ToolGroupingOptions(hasMoreMessages = false),
    ).filterIsInstance<ToolGroupBlock>().single()

    @Test fun `selected content follows live updates then retains a read only snapshot`() {
        val state = ChatInspectionState()
        val first = tool("read-1")
        val message = UserTextBlock("prompt", null, 0, null, "  exact\r\ntext ", null, null, null, null)
        state.update(listOf(first, message))
        state.retainTool(first.id)
        state.retainMessage(message.id)
        val updated = tool(first.id, "latest", "completed")
        state.update(listOf(updated, message))
        assertSame(updated, state.tool(first.id)?.value)
        assertFalse(state.tool(first.id)!!.stale)
        state.update(emptyList())
        assertSame(updated, state.tool(first.id)?.value)
        assertTrue(state.tool(first.id)!!.stale)
        assertEquals(message.text, state.message(message.id)?.value?.text)
        assertTrue(state.message(message.id)!!.stale)
        state.clearSelections()
        assertNull(state.tool(first.id))
        assertNull(state.message(message.id))
    }

    @Test fun `missing group preserves membership while remaining tools keep updating`() {
        val state = ChatInspectionState()
        val members = (1..12).map { tool("read-$it") }
        val original = group(members)
        state.update(listOf(original))
        state.retainGroup(original.id)
        val remaining = tool("read-12", "new result", "completed")
        state.update(listOf(remaining))
        val retained = state.group(original.id)!!
        assertTrue(retained.stale)
        assertEquals(members.map { it.id }, retained.value.tools.map { it.id })
        assertSame(remaining, retained.value.tools.last())
        assertTrue(state.tool("read-1")!!.stale)
        assertFalse(state.tool("read-12")!!.stale)
        state.retainTool("read-1")
        state.update(emptyList())
        assertEquals("first", (state.tool("read-1")!!.value.tool.result as JsonPrimitive).content)
        state.invalidate()
        assertNull(state.group(original.id))
        assertNull(state.tool("read-1"))
        assertEquals(1L, state.reset.value)
    }

    @Test fun `transcript summaries reuse identity during output updates without modifying detail`() {
        val projection = TranscriptProjection()
        val first = tool("read-1")
        val firstProjection = projection.project(listOf(first)).single() as ToolCallBlock
        assertNull(firstProjection.tool.result)
        assertNotNull(first.tool.result)
        val updated = tool(first.id, "x".repeat(1_000_000))
        assertSame(firstProjection, projection.project(listOf(updated)).single())
        val completed = tool(first.id, "complete", "completed")
        assertNotSame(firstProjection, projection.project(listOf(completed)).single())
        val grouped = group((1..12).map { tool("group-$it") })
        val summary = projection.project(listOf(grouped)).single() as ToolGroupBlock
        assertTrue(summary.tools.isEmpty())
        assertEquals(12, grouped.tools.size)
        val outputUpdate = group(grouped.tools.map { tool(it.id, "changed") })
        assertSame(summary, projection.project(listOf(outputUpdate)).single())
    }

    @Test fun `inline plan proposals retain results and refresh diagnostics during output updates`() {
        for (name in listOf("ExitPlanMode", "exit_plan_mode")) {
            val projection = TranscriptProjection()
            fun proposal(result: String) = previewToolCall(
                "proposal", name, state = ToolState.ERROR, input = mapOf("plan" to "# Review this plan"),
            ).also { it.tool = it.tool.copy(result = JsonPrimitive(result)) }

            val first = proposal("Plan failed to apply")
            val firstProjection = projection.project(listOf(first)).single() as ToolCallBlock
            assertEquals(first.tool.input, firstProjection.tool.input)
            assertEquals(first.tool.result, firstProjection.tool.result)

            val updated = proposal("Updated failure details")
            val updatedProjection = projection.project(listOf(updated)).single() as ToolCallBlock
            assertNotSame(firstProjection, updatedProjection)
            assertEquals(updated.tool.result, updatedProjection.tool.result)
        }
    }

    @Test fun `epoch replacement clears old selection and publishes new live records atomically`() {
        val state = ChatInspectionState()
        state.update(listOf(tool("old")), epoch = 1L)
        state.retainTool("old")
        val fresh = tool("fresh")
        state.update(listOf(fresh), epoch = 2L)
        assertEquals(1L, state.reset.value)
        assertNull(state.tool("old"))
        assertSame(fresh, state.tool("fresh")?.value)
        assertFalse(state.tool("fresh")!!.stale)
    }
}

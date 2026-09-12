package app.hapi.protocol.chat

import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.Test

class ToolGroupIdentityTest {
    private fun tool(id: String) = ToolCallBlock(
        id = id, localId = null, createdAt = 0, invokedAt = null,
        tool = ChatToolCall(id, "Read", "completed", input = null, createdAt = 0, description = null),
        children = emptyList(), meta = null,
    )

    private fun text(id: String = "text") = AgentTextBlock(
        id = id, localId = null, createdAt = 0, invokedAt = null, text = "Between tool runs", meta = null,
    )

    private fun groups(blocks: List<ChatBlock>, more: Boolean = false, previous: List<ToolGroupBlock> = emptyList()) =
        buildVisibleChatBlocks(blocks, ToolGroupingOptions(hasMoreMessages = more, previousGroups = previous))
            .filterIsInstance<ToolGroupBlock>()

    @Test fun `a split claims its old identity only once and retains all tools`() {
        for (more in listOf(false, true)) {
            val tools = listOf("a", "b", "c", "d").map(::tool)
            val previous = groups(tools, more)
            val split = listOf(tools[0], tools[1], text(), tools[2], tools[3])
            val next = groups(split, more, previous)
            assertEquals(2, next.size)
            assertEquals(2, next.map { it.id }.toSet().size)
            assertEquals(1, next.count { it.id == previous.single().id })
            assertEquals(listOf("a", "b", "c", "d"), next.flatMap { it.tools }.map { it.id })
            assertEquals(next.map { it.id }, groups(split, more, next).map { it.id })
        }
    }

    @Test fun `fallback cannot collide with an already claimed historical id`() {
        val original = groups(listOf(tool("c"), tool("d")))
        val grown = groups(listOf("a", "b", "c", "d").map(::tool), previous = original)
        val split = listOf(tool("a"), tool("b"), text(), tool("c"), tool("d"))
        val next = groups(split, previous = grown)
        assertEquals(original.single().id, next[0].id)
        assertNotEquals(next[0].id, next[1].id)
        assertEquals(next.map { it.id }, groups(split, previous = next).map { it.id })
    }

    @Test fun `a prepended group cannot steal the surviving groups id`() {
        val original = groups(listOf("c", "d", "e").map(::tool))
        val trimmed = groups(listOf(tool("d"), tool("e")), previous = original)
        val prepended = listOf(tool("a"), tool("b"), tool("c"), text(), tool("d"), tool("e"))
        val next = groups(prepended, more = true, previous = trimmed)
        assertEquals(2, next.size)
        assertNotEquals(next[0].id, next[1].id)
        assertEquals(original.single().id, next[1].id)
        assertEquals(next.map { it.id }, groups(prepended, more = true, previous = next).map { it.id })
    }

    @Test fun `both boundary collisions use a stable suffix without dropping any block`() {
        val blocks = listOf(text("tool-group:a"), tool("a"), tool("b"), text("tool-group:b"))
        val visible = buildVisibleChatBlocks(blocks, ToolGroupingOptions(hasMoreMessages = false))
        val group = visible.filterIsInstance<ToolGroupBlock>().single()
        assertEquals("tool-group:a#2", group.id)
        assertEquals(3, visible.size)
        assertEquals(group.id, groups(blocks, previous = listOf(group)).single().id)
    }
}

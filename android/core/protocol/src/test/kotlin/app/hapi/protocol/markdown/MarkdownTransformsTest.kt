package app.hapi.protocol.markdown

import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.Text
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class MarkdownTransformsTest {

    // ── repairTables (remark-repair-tables parity) ───────────────────────────

    @Test
    fun `pads a separator row truncated by streaming`() {
        val source = "| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |"

        val repaired = MarkdownTransforms.repairTables(source)

        assertEquals("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |", repaired)
    }

    @Test
    fun `preserves alignment hints in existing separator cells`() {
        val source = "| A | B | C |\n|:--|--:|"

        val repaired = MarkdownTransforms.repairTables(source)

        assertEquals("| A | B | C |\n|:--|--:| --- |", repaired)
    }

    @Test
    fun `repairs a separator truncated to a single cell`() {
        val source = "| Name | Type | Default |\n| --- |"

        val repaired = MarkdownTransforms.repairTables(source)

        assertEquals("| Name | Type | Default |\n| --- | --- | --- |", repaired)
    }

    @Test
    fun `leaves headers without a leading pipe alone`() {
        val source = "A | B | C\n| --- | --- |"

        assertSame(source, MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `never touches table-like lines inside fenced code`() {
        val source = "```\n| A | B | C |\n| --- |\n```"

        assertSame(source, MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `a shorter fence does not close a longer opener`() {
        // GFM 4.5: the closer must be at least as long as the opener, so the
        // inner ``` keeps the ```` fence open and the table stays untouched.
        val source = "````\n```\n| A | B |\n| --- |\n````"

        assertSame(source, MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `pipes inside code spans do not count as cells`() {
        val source = "| `a|b` | c |\n| --- |"

        assertEquals("| `a|b` | c |\n| --- | --- |", MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `escaped pipes do not count as cells`() {
        val source = "| a \\| b | c |\n| --- |"

        assertEquals("| a \\| b | c |\n| --- | --- |", MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `keeps indentation when replacing the separator`() {
        val source = "  | A | B |\n  | --- |"

        assertEquals("  | A | B |\n  | --- | --- |", MarkdownTransforms.repairTables(source))
    }

    @Test
    fun `returns the same instance when nothing needs repair`() {
        val source = "| A | B |\n| --- | --- |\n| 1 | 2 |"

        assertSame(source, MarkdownTransforms.repairTables(source))
    }

    // ── Parser configuration (disableIndentedCode + extensions) ──────────────

    @Test
    fun `indented code blocks are disabled`() {
        val doc = MarkdownTransforms.parse("intro\n\n    1. indented list continuation")

        assertTrue(collect(doc).none { it is IndentedCodeBlock })
    }

    @Test
    fun `fenced code blocks still parse`() {
        val doc = MarkdownTransforms.parse("```kotlin\nval x = 1\n```")

        val fence = collect(doc).filterIsInstance<FencedCodeBlock>().single()
        assertEquals("kotlin", fence.info)
        assertEquals("val x = 1\n", fence.literal)
    }

    @Test
    fun `double tilde strikes through but single tilde stays literal`() {
        val doc = MarkdownTransforms.parse("a ~~gone~~ and user@host:~\$ stays")

        val nodes = collect(doc)
        assertEquals(1, nodes.count { it is Strikethrough })
        val text = nodes.filterIsInstance<Text>().joinToString("") { it.literal }
        assertTrue(text.contains("user@host:~\$ stays"))
    }

    @Test
    fun `broken table parses into a full-width table after repair`() {
        val doc = MarkdownTransforms.parse("| A | B | C |\n| --- |\n| 1 | 2 | 3 |")

        val nodes = collect(doc)
        assertEquals(1, nodes.count { it is TableBlock })
        val head = nodes.filterIsInstance<TableHead>().single()
        assertEquals(3, collect(head).count { it is TableCell })
    }

    @Test
    fun `bare urls autolink`() {
        val doc = MarkdownTransforms.parse("see https://example.com/docs now")

        val link = collect(doc).filterIsInstance<Link>().single()
        assertEquals("https://example.com/docs", link.destination)
    }

    @Test
    fun `four-space indent inside prose stays a paragraph`() {
        val doc = MarkdownTransforms.parse("    plain indented prose")

        assertTrue(doc.firstChild is Paragraph)
    }

    // ── stripCjkAutolinkArtifacts ────────────────────────────────────────────

    @Test
    fun `strips trailing cjk comma from an autolinked url`() {
        val split = MarkdownTransforms.stripCjkAutolinkArtifacts("https://example.com/a，")

        assertEquals("https://example.com/a", split.url)
        assertEquals("，", split.trailing)
    }

    @Test
    fun `strips sentence-ender plus closing bracket`() {
        val split = MarkdownTransforms.stripCjkAutolinkArtifacts("https://example.com/a。）")

        assertEquals("https://example.com/a", split.url)
        assertEquals("。）", split.trailing)
    }

    @Test
    fun `plain ascii urls come back unchanged`() {
        val split = MarkdownTransforms.stripCjkAutolinkArtifacts("https://example.com/path")

        assertEquals("https://example.com/path", split.url)
        assertEquals("", split.trailing)
    }

    @Test
    fun `a closing bracket alone is not stripped`() {
        // Brackets are valid URL characters; they only come off behind a
        // sentence-ending punctuation mark, mirroring the web regex.
        val split = MarkdownTransforms.stripCjkAutolinkArtifacts("https://example.com/a）")

        assertEquals("https://example.com/a）", split.url)
        assertEquals("", split.trailing)
    }

    private fun collect(root: Node): List<Node> {
        val out = mutableListOf<Node>()
        fun walk(node: Node) {
            out += node
            var child = node.firstChild
            while (child != null) {
                walk(child)
                child = child.next
            }
        }
        walk(root)
        return out
    }
}

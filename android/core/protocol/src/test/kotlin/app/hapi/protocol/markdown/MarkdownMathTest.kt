package app.hapi.protocol.markdown

import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.node.BlockQuote
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Image
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Math extraction semantics, mirroring the web test names in
 * `web/src/lib/remark-latex-bracket-math.test.ts` and the currency suite of
 * `web/src/components/assistant-ui/markdown-text.test.ts` (remark-math with
 * `singleDollarTextMath: false`). Assertions are AST-level: which
 * [MathBlockNode]/[MathInlineNode] nodes exist, their latex values and block
 * placement, and that no private-use placeholder token ever leaks into the
 * final tree.
 */
class MarkdownMathTest {

    private fun parse(markdown: String): Document = MarkdownTransforms.parse(markdown) as Document

    private fun <T : Node> Node.collectOfType(type: Class<T>): List<T> {
        val out = ArrayList<T>()
        fun walk(node: Node) {
            var child = node.firstChild
            while (child != null) {
                if (type.isInstance(child)) out.add(type.cast(child))
                walk(child)
                child = child.next
            }
        }
        walk(this)
        return out
    }

    private inline fun <reified T : Node> Node.collect(): List<T> = collectOfType(T::class.java)

    private fun Node.allText(): String {
        val out = StringBuilder()
        fun walk(node: Node) {
            var child = node.firstChild
            while (child != null) {
                if (child is Text) out.append(child.literal)
                else walk(child)
                child = child.next
            }
        }
        walk(this)
        return out.toString()
    }

    private fun Document.mathBlocks(): List<MathBlockNode> = collectOfType(MathBlockNode::class.java)

    private fun Document.mathInlines(): List<MathInlineNode> = collectOfType(MathInlineNode::class.java)

    private fun Document.topBlocks(): List<Node> {
        val blocks = ArrayList<Node>()
        var child = firstChild
        while (child != null) {
            blocks.add(child)
            child = child.next
        }
        return blocks
    }

    /** Web parity: `expect(html).not.toContain('\uE000')`. */
    private fun assertNoPlaceholderTokens(document: Document) {
        for (text in document.collect<Text>()) {
            for (ch in text.literal.orEmpty()) {
                assertTrue(
                    ch.code !in 0xE000..0xF8FF,
                    "placeholder token leaked into text: \"${text.literal}\"",
                )
            }
        }
        for (code in document.collect<Code>()) {
            for (ch in code.literal.orEmpty()) {
                assertTrue(ch.code !in 0xE000..0xF8FF, "placeholder token leaked into code span")
            }
        }
        for (fence in document.collect<FencedCodeBlock>()) {
            for (ch in fence.literal.orEmpty()) {
                assertTrue(ch.code !in 0xE000..0xF8FF, "placeholder token leaked into fenced code")
            }
        }
    }

    // ── Bracket math ─────────────────────────────────────────────────────────

    @Test
    fun `renders display bracket math`() {
        val document = parse("""\[E = mc^2\]""")

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("E = mc^2"), math.map { it.latex })
        assertEquals(0, document.collect<MathInlineNode>().size)
        assertEquals(0, document.collect<Paragraph>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders parenthesized inline math`() {
        val document = parse("""Result: \(x^2 + y^2\).""")

        val math = document.collect<MathInlineNode>()
        assertEquals(listOf("x^2 + y^2"), math.map { it.latex })
        assertEquals(0, document.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders multiline display math before optional hard-break processing`() {
        val document = parse(
            """
            Before

            \[
            E = mc^2
            \]

            After
            """.trimIndent(),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("E = mc^2"), math.map { it.latex })
        val paragraphs = document.collect<Paragraph>().map { it.allText() }
        assertEquals(listOf("Before", "After"), paragraphs)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders multiple inline formulas in one paragraph`() {
        val document = parse("""Compare \(a^2\) with \(b^2\).""")

        assertEquals(listOf("a^2", "b^2"), document.collect<MathInlineNode>().map { it.latex })
        assertEquals(1, document.collect<Paragraph>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders aligned display math with TeX line breaks and indentation`() {
        val document = parse(
            """
            \[
            \begin{aligned}
            f(x) &= x^2+2x+1 \\
                 &= (x+1)^2
            \end{aligned}
            \]
            """.trimIndent(),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(1, math.size)
        assertEquals(
            "\\begin{aligned}\nf(x) &= x^2+2x+1 \\\\\n     &= (x+1)^2\n\\end{aligned}",
            math.single().latex,
        )
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `hoists display math out of surrounding prose`() {
        val document = parse("""Before \[x^2\] after""")

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("x^2"), math.map { it.latex })
        val paragraphs = document.collect<Paragraph>().map { it.allText() }
        assertEquals(listOf("Before ", " after"), paragraphs)
        // The hoisted math must sit between the two prose paragraphs.
        val blocks = document.topBlocks()
        assertEquals(3, blocks.size)
        assertTrue(
            blocks[1] is MathBlockNode,
            "expected math between the paragraphs, got ${blocks.map { it.javaClass.simpleName }}",
        )
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `preserves common LaTeX commands inside display math`() {
        val document = parse(
            """
            \[
            \lim_{x\to 0}\frac{\sin x}{x}=1
            \]
            """.trimIndent(),
        )

        assertEquals(
            listOf("\\lim_{x\\to 0}\\frac{\\sin x}{x}=1"),
            document.collect<MathBlockNode>().map { it.latex },
        )
    }

    @Test
    fun `renders the multiline transfer-function formulas from the real session`() {
        val document = parse(
            """
            \[
            \Phi(s)=
            \frac{\dfrac{K^*(s+4)}{s(s+2)(s+3)}}
            {1+\dfrac{K^*}{s(s+3)}}
            \]

            \[
            \Phi(s)
            =
            \frac{K^*(s+4)}
            {(s+2)\left[s(s+3)+K^*\right]}
            \]

            \[
            \Phi(s)=
            \frac{9(s+4)}
            {(s+2)(s^2+3s+9)}
            \]

            \[
            \Phi(s)
            =
            \frac{9}{s^2+3s+9}
            \frac{s+4}{s+2}
            \]
            """.trimIndent(),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(4, math.size)
        assertTrue(math[0].latex.contains("\\dfrac"), "first formula lost its nested fraction")
        assertTrue(math[1].latex.contains("\\left[s(s+3)+K^*\\right]"))
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders percent and text commands from the real session`() {
        val document = parse(
            """
            标准二阶系统超调量：

            \[
            \sigma\% =
            e^{-\frac{\pi\zeta}{\sqrt{1-\zeta^2}}}\times100\%
            \]

            \[
            t_s\approx\frac{4}{0.5\times3}
            \approx2.67\text{ s}
            \]
            """.trimIndent(),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(2, math.size)
        assertTrue(math[1].latex.contains("\\text{ s}"))
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `recurses through inline formatting while keeping the display node block-level`() {
        val document = parse("""**Before \(x^2\) after**""")

        val emphasis = document.collect<StrongEmphasis>()
        assertEquals(1, emphasis.size)
        assertEquals(listOf("x^2"), emphasis.single().collect<MathInlineNode>().map { it.latex })
        assertEquals(0, document.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(document)
    }

    // ── Literal passthrough ──────────────────────────────────────────────────

    @Test
    fun `leaves inline code as text`() {
        val document = parse("""Use `\(x^2\)` here.""")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertEquals(listOf("\\(x^2\\)"), document.collect<Code>().map { it.literal })
    }

    @Test
    fun `leaves fenced code as text`() {
        val document = parse("```latex\n\\[x^2\\]\n```")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertEquals(listOf("\\[x^2\\]\n"), document.collect<FencedCodeBlock>().map { it.literal })
    }

    @Test
    fun `leaves escaped delimiters as text`() {
        val document = parse("""Literal \\(x^2\\) and \\[y^2\\]""")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `leaves an unclosed delimiter as text`() {
        val document = parse("""Literal \(x^2""")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
    }

    @Test
    fun `does not let an unmatched opener consume a protected code block`() {
        val document = parse(
            listOf(
                """Literal \(""",
                "```latex",
                """\[x^2\]""",
                "```",
                "",
                """\(y^2\)""",
            ).joinToString("\n"),
        )

        assertEquals(listOf("\\[x^2\\]\n"), document.collect<FencedCodeBlock>().map { it.literal })
        assertEquals(listOf("y^2"), document.collect<MathInlineNode>().map { it.latex })
        assertTrue(document.allText().contains("Literal ("), "the lone opener must stay literal text")
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `preserves quoted fences and multiline code spans as literal Markdown`() {
        val quotedFence = parse(
            listOf(
                "> ```latex",
                "> \\[x^2\\]",
                "> ````",
            ).joinToString("\n"),
        )
        assertEquals(0, quotedFence.collect<MathInlineNode>().size + quotedFence.collect<MathBlockNode>().size)
        assertEquals(listOf("\\[x^2\\]\n"), quotedFence.collect<FencedCodeBlock>().map { it.literal })

        val multilineCodeSpan = parse(
            listOf(
                "Use `before",
                """\[x^2\]""",
                "after` here.",
            ).joinToString("\n"),
        )
        assertEquals(0, multilineCodeSpan.collect<MathInlineNode>().size + multilineCodeSpan.collect<MathBlockNode>().size)
        // CommonMark converts newlines inside a code span to spaces; the
        // delimiters just have to stay literal.
        assertEquals(listOf("before \\[x^2\\] after"), multilineCodeSpan.collect<Code>().map { it.literal })
    }

    // ── Container prefixes ───────────────────────────────────────────────────

    @Test
    fun `removes blockquote prefixes from multiline bracket math`() {
        val document = parse(
            listOf(
                "> \\[",
                "> x = 1",
                "> \\]",
            ).joinToString("\n"),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("x = 1"), math.map { it.latex })
        assertEquals(1, document.collect<BlockQuote>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `removes blockquote prefixes from dollar flow math`() {
        val document = parse(
            listOf(
                "> $$",
                "> E = mc^2",
                "> F = ma",
                "> $$",
            ).joinToString("\n"),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("E = mc^2\nF = ma"), math.map { it.latex })
        assertEquals(1, document.collect<BlockQuote>().size)
        assertNoPlaceholderTokens(document)

        val singleLine = parse(
            listOf(
                "> $$",
                "> E",
                "> $$",
            ).joinToString("\n"),
        )
        assertEquals(listOf("E"), singleLine.collect<MathBlockNode>().map { it.latex })
        assertNoPlaceholderTokens(singleLine)
    }

    @Test
    fun `preserves blockquote prefixes when prose precedes multiline bracket math`() {
        val document = parse(
            listOf(
                "> Result: \\[",
                "> x = 1",
                "> \\]",
            ).joinToString("\n"),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("x = 1"), math.map { it.latex })
        val quotes = document.collect<BlockQuote>()
        assertEquals(1, quotes.size)
        assertEquals(listOf("Result: "), quotes.single().collect<Paragraph>().map { it.allText() })
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `keeps mathematical greater-than signs in unquoted multiline bracket math`() {
        val document = parse(
            listOf(
                "\\[",
                "x",
                "> 0",
                "\\]",
            ).joinToString("\n"),
        )

        assertEquals(listOf("x\n> 0"), document.collect<MathBlockNode>().map { it.latex })
        assertNoPlaceholderTokens(document)
    }

    // ── Lists and fences ─────────────────────────────────────────────────────

    @Test
    fun `preserves list-contained fences and renders following bracket math`() {
        val document = parse(
            listOf(
                "- ```latex",
                "  \\[x^2\\]",
                "  ````",
                "",
                """\(y^2\)""",
            ).joinToString("\n"),
        )

        assertEquals(listOf("\\[x^2\\]\n"), document.collect<FencedCodeBlock>().map { it.literal })
        assertEquals(listOf("y^2"), document.collect<MathInlineNode>().map { it.latex })
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `recognizes ordered-list fence indentation before following bracket math`() {
        val document = parse(
            listOf(
                "10. ```latex",
                "    \\[x^2\\]",
                "    ````",
                "",
                """\(y^2\)""",
            ).joinToString("\n"),
        )

        assertEquals(listOf("\\[x^2\\]\n"), document.collect<FencedCodeBlock>().map { it.literal })
        assertEquals(listOf("y^2"), document.collect<MathInlineNode>().map { it.latex })
    }

    @Test
    fun `allows a list-relative closing fence indentation`() {
        val document = parse(
            listOf(
                "- ```latex",
                "  \\[x^2\\]",
                "    ````",
                "",
                """\(y^2\)""",
            ).joinToString("\n"),
        )

        assertEquals(listOf("\\[x^2\\]\n"), document.collect<FencedCodeBlock>().map { it.literal })
        assertEquals(listOf("y^2"), document.collect<MathInlineNode>().map { it.latex })
    }

    @Test
    fun `keeps multiline bracket math inside a list item`() {
        val document = parse(
            listOf(
                "- \\[",
                "  x = 1",
                "  \\]",
            ).joinToString("\n"),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("x = 1"), math.map { it.latex })
        val items = document.collect<ListItem>()
        assertEquals(1, items.size)
        assertTrue(items.single().collect<MathBlockNode>().isNotEmpty(), "math must stay inside the list item")
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `normalizes nested list and blockquote prefixes in multiline bracket math`() {
        val document = parse(
            listOf(
                "- > \\[",
                "  > x = 1",
                "  > \\]",
            ).joinToString("\n"),
        )

        val math = document.collect<MathBlockNode>()
        assertEquals(listOf("x = 1"), math.map { it.latex })
        assertEquals(1, document.collect<BlockQuote>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders bracket math across an empty TeX line`() {
        val document = parse(
            listOf(
                "\\[",
                "a",
                "",
                "+ b",
                "\\]",
            ).joinToString("\n"),
        )

        assertEquals(listOf("a\n\n+ b"), document.collect<MathBlockNode>().map { it.latex })
        assertNoPlaceholderTokens(document)
    }

    // ── Link / image / definition metadata ───────────────────────────────────

    @Test
    fun `keeps escaped parentheses in link, image, and definition destinations`() {
        val link = parse("""[source](https://example.com/foo\(bar\).ts)""")
        assertEquals(listOf("https://example.com/foo(bar).ts"), link.collect<Link>().map { it.destination })
        assertEquals(0, link.collect<MathInlineNode>().size + link.collect<MathBlockNode>().size)

        val image = parse("""![source](https://example.com/foo\(bar\).png)""")
        assertEquals(listOf("https://example.com/foo(bar).png"), image.collect<Image>().map { it.destination })
        assertEquals(0, image.collect<MathInlineNode>().size + image.collect<MathBlockNode>().size)

        val definition = parse("[source][id]\n\n[id]: https://example.com/foo\\(bar\\).ts")
        val resolved = definition.collect<Link>().map { it.destination }
        assertEquals(listOf("https://example.com/foo(bar).ts"), resolved)
        assertEquals(0, definition.collect<MathInlineNode>().size + definition.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(definition)
    }

    @Test
    fun `preserves image alt text and reference identifiers containing delimiters`() {
        val image = parse("""![\(x\)](https://example.com/image.png)""")
        assertEquals(1, image.collect<Image>().size)
        assertEquals(0, image.collect<MathInlineNode>().size + image.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(image)

        val reference = parse("[source][\\(id\\)]\n\n[\\(id\\)]: https://example.com/foo")
        assertEquals(1, reference.collect<Link>().size)
        assertEquals(0, reference.collect<MathInlineNode>().size + reference.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(reference)
    }

    @Test
    fun `preserves reference-image alt text and implicit link identifiers`() {
        val imageReference = parse("![\\(x\\)][id]\n\n[id]: https://example.com/image.png")
        assertEquals(1, imageReference.collect<Image>().size)
        assertEquals(0, imageReference.collect<MathInlineNode>().size + imageReference.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(imageReference)

        val collapsed = parse("[\\(x\\)][]\n\n[\\(x\\)]: https://example.com")
        assertEquals(1, collapsed.collect<Link>().size)
        assertNoPlaceholderTokens(collapsed)

        val shortcut = parse("[\\(x\\)]\n\n[\\(x\\)]: https://example.com")
        assertEquals(1, shortcut.collect<Link>().size)
        assertNoPlaceholderTokens(shortcut)
    }

    // ── Dollar math (remark-math `singleDollarTextMath: false`) ──────────────

    @Test
    fun `does not render single-dollar currency amounts as math`() {
        val document = parse("The plan is \$200/mo and the bill is \$80 — total \$400 saved.")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertTrue(document.allText().contains("\$200"))
        assertTrue(document.allText().contains("\$80"))
        assertTrue(document.allText().contains("\$400"))
    }

    @Test
    fun `does not render the reported real-world prose as math`() {
        val document = parse("Cursor's UI quotes the ratio: at least \$400 of API usage on a \$200 plan. That's 2:1.")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertTrue(document.allText().contains("\$400"))
        assertTrue(document.allText().contains("\$200"))
    }

    @Test
    fun `still renders block math with dollar-dollar on its own lines`() {
        val document = parse("Before\n\n\$\$\nE = mc^2\n\$\$\n\nAfter")

        assertEquals(listOf("E = mc^2"), document.collect<MathBlockNode>().map { it.latex })
        assertEquals(listOf("Before", "After"), document.collect<Paragraph>().map { it.allText() })
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `renders mid-paragraph dollar-dollar as inline math`() {
        val document = parse("Euler says \$\$e^{i\\pi} + 1 = 0\$\$ exactly.")

        assertEquals(listOf("e^{i\\pi} + 1 = 0"), document.collect<MathInlineNode>().map { it.latex })
        assertEquals(0, document.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `requires a matching dollar run size for inline math`() {
        // A `$$$` opener needs an equal three-dollar closer; without one the
        // whole run stays literal (the inner `$$` is part of the opener).
        val document = parse("a \$\$\$x\$\$ b")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
    }

    @Test
    fun `treats backslash-escaped dollars as literal`() {
        val document = parse("He said " + "\\$" + "\\$" + "x" + "\\$" + "\\$" + " loudly.")

        assertEquals(0, document.collect<MathInlineNode>().size + document.collect<MathBlockNode>().size)
        assertNoPlaceholderTokens(document)
    }

    @Test
    fun `does not close flow math through a fenced code block`() {
        val document = parse(
            listOf(
                "\$\$",
                "```",
                "not a closer \$\$",
                "```",
                "\$\$",
            ).joinToString("\n"),
        )

        // The `$$` inside the fence is protected, so the real closer wins and
        // the fence lines become math content (math flow, like code fences,
        // is not interrupted by ```).
        assertEquals(
            listOf("```\nnot a closer \$\$\n```"),
            document.collect<MathBlockNode>().map { it.latex },
        )
        assertEquals(0, document.collect<FencedCodeBlock>().size)
    }

    @Test
    fun `preserves bracket-like TeX commands inside existing dollar math`() {
        val document = parse("\$\$\\verb|\\(x\\)|\$\$")

        assertEquals(listOf("""\verb|\(x\)|"""), document.collect<MathInlineNode>().map { it.latex })
        assertNoPlaceholderTokens(document)
    }

    // ── Interaction with table repair ────────────────────────────────────────

    @Test
    fun `keeps bracket math after the existing table source repair`() {
        val document = parse(
            listOf(
                "| A | B | C |",
                "|---|---|",
                "| x | y | z |",
                "",
                """\[E = mc^2\]""",
            ).joinToString("\n"),
        )

        assertEquals(1, document.collect<TableBlock>().size)
        assertEquals(listOf("E = mc^2"), document.collect<MathBlockNode>().map { it.latex })
        assertNoPlaceholderTokens(document)
    }
}

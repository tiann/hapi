package app.hapi.protocol.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FilePathLinksTest {

    // ── detectFilePathLinks ──────────────────────────────────────────────────

    @Test
    fun `links a unix relative path in prose`() {
        val text = "see src/lib/utils.ts for details"

        val links = MarkdownTransforms.detectFilePathLinks(text)

        assertEquals(1, links.size)
        val link = links.single()
        assertEquals("src/lib/utils.ts", link.path)
        assertNull(link.line)
        assertEquals("src/lib/utils.ts", text.substring(link.range))
    }

    @Test
    fun `parses line and column suffixes`() {
        val links = MarkdownTransforms.detectFilePathLinks("open a/b.ts:12 and c/d.py:3:7 please")

        assertEquals(2, links.size)
        assertEquals("a/b.ts", links[0].path)
        assertEquals(12, links[0].line)
        assertNull(links[0].column)
        assertEquals("a/b.ts:12", links[0].display)
        assertEquals("c/d.py", links[1].path)
        assertEquals(3, links[1].line)
        assertEquals(7, links[1].column)
    }

    @Test
    fun `strips trailing prose punctuation from the display path`() {
        val text = "read docs/guide.md."

        val link = MarkdownTransforms.detectFilePathLinks(text).single()

        assertEquals("docs/guide.md", link.path)
        assertEquals("docs/guide.md", text.substring(link.range))
    }

    @Test
    fun `strips an unbalanced closing paren`() {
        val link = MarkdownTransforms.detectFilePathLinks("(see src/a.ts)").single()

        assertEquals("src/a.ts", link.path)
    }

    @Test
    fun `links dot-slash paths and lockfiles`() {
        val links = MarkdownTransforms.detectFilePathLinks("./local.md and yarn.lock changed")

        assertEquals(listOf("./local.md", "yarn.lock"), links.map { it.path })
    }

    @Test
    fun `links windows absolute paths`() {
        val link = MarkdownTransforms.detectFilePathLinks("check C:\\proj\\app.kt now").single()

        assertEquals("C:\\proj\\app.kt", link.path)
    }

    @Test
    fun `bare names with allowlisted extensions link (web parity)`() {
        // Same behavior as the web plugin: `Node.js` has an allowlisted
        // extension and links; the extension allowlist (no org/com/io) is what
        // keeps domains and most prose out.
        val links = MarkdownTransforms.detectFilePathLinks("Node.js is great")

        assertEquals(listOf("Node.js"), links.map { it.path })
    }

    @Test
    fun `does not link paths inside urls`() {
        assertTrue(MarkdownTransforms.detectFilePathLinks("https://example.com/foo.ts").isEmpty())
    }

    @Test
    fun `does not link domains without file extensions`() {
        assertTrue(MarkdownTransforms.detectFilePathLinks("visit example.org today").isEmpty())
    }

    @Test
    fun `does not link ratios or version numbers`() {
        assertTrue(MarkdownTransforms.detectFilePathLinks("a ratio of 16:9").isEmpty())
        assertTrue(MarkdownTransforms.detectFilePathLinks("v1.2.3 released").isEmpty())
    }

    @Test
    fun `does not link posix absolute or parent-traversal paths`() {
        assertTrue(MarkdownTransforms.detectFilePathLinks("/abs/path/file.ts").isEmpty())
        assertTrue(MarkdownTransforms.detectFilePathLinks("../up/secret.ts").isEmpty())
    }

    // ── matchWholeFilePath (inline code spans) ───────────────────────────────

    @Test
    fun `whole-value code span paths link`() {
        val link = MarkdownTransforms.matchWholeFilePath("web/src/foo.tsx")

        assertEquals("web/src/foo.tsx", link?.path)
    }

    @Test
    fun `code span with line suffix links and carries the line`() {
        val link = MarkdownTransforms.matchWholeFilePath("hub/src/startHub.ts:345")

        assertEquals("hub/src/startHub.ts", link?.path)
        assertEquals(345, link?.line)
    }

    @Test
    fun `real code snippets never link`() {
        assertNull(MarkdownTransforms.matchWholeFilePath("npm run build"))
        assertNull(MarkdownTransforms.matchWholeFilePath("str.split()"))
        assertNull(MarkdownTransforms.matchWholeFilePath("x.md#y"))
        assertNull(MarkdownTransforms.matchWholeFilePath("Math.PI"))
        assertNull(MarkdownTransforms.matchWholeFilePath(""))
    }

    // ── rewriteExplicitLinkTarget ────────────────────────────────────────────

    @Test
    fun `rewrites repo-relative link targets`() {
        assertEquals("docs/guide.md", MarkdownTransforms.rewriteExplicitLinkTarget("docs/guide.md#install"))
        assertEquals("src/a.ts", MarkdownTransforms.rewriteExplicitLinkTarget("src/a.ts:12"))
        assertEquals("./readme.md", MarkdownTransforms.rewriteExplicitLinkTarget("./readme.md"))
        assertEquals("sub/dir/img.png", MarkdownTransforms.rewriteExplicitLinkTarget("sub/dir/img.png?x=1"))
    }

    @Test
    fun `keeps url semantics for absolute schemed and unknown targets`() {
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("/abs/a.ts"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("https://x.com/a.ts"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("mailto:a@b.c"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("../up.ts"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("/settings"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("#section"))
    }

    @Test
    fun `windows absolute targets need an allowlisted extension`() {
        assertEquals("C:/w/a.ts", MarkdownTransforms.rewriteExplicitLinkTarget("C:/w/a.ts"))
        assertNull(MarkdownTransforms.rewriteExplicitLinkTarget("C:/w/a"))
    }
}

package app.hapi.protocol.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionPathLinksTest {

    // ── parseSessionPathHref (web sessionReference.test.ts mirror) ──────────

    @Test
    fun `parses plain and encoded session paths`() {
        assertEquals("abc-def", SessionPathLinks.parseSessionPathHref("/sessions/abc-def"))
        // decodeURIComponent('%2F') == '/': the id may contain slashes.
        assertEquals("a/b", SessionPathLinks.parseSessionPathHref("/sessions/a%2Fb"))
    }

    @Test
    fun `rejects absolute URLs and non-session paths`() {
        assertNull(SessionPathLinks.parseSessionPathHref("https://example.com/sessions/x"))
        assertNull(SessionPathLinks.parseSessionPathHref("/settings/general"))
    }

    @Test
    fun `rejects dotted tails that look like filenames`() {
        assertNull(SessionPathLinks.parseSessionPathHref("/sessions/chat.tsx"))
        assertNull(SessionPathLinks.parseSessionPathHref("web/src/routes/sessions/chat.tsx"))
    }

    @Test
    fun `strips a single trailing slash and decodes id`() {
        assertEquals("abc", SessionPathLinks.parseSessionPathHref("/sessions/abc/"))
    }

    // ── detectBareSessionCitations (web remark plugin mirror) ───────────────

    @Test
    fun `linkifies bare session path in a citation sentence`() {
        val text = "See session \"upstream issue/pr discovery\" (/sessions/abc-def) for context"

        val citations = SessionPathLinks.detectBareSessionCitations(text)

        assertEquals(1, citations.size)
        val citation = citations.single()
        assertEquals("abc-def", citation.sessionId)
        assertEquals("/sessions/abc-def", citation.display)
        assertEquals("/sessions/abc-def", text.substring(citation.range))
    }

    @Test
    fun `detects citations at end of text and before a sentence period`() {
        // Locks the JVM `$`-vs-JS edge: Java `$` also matches before a final
        // line terminator, but a trailing `\n` satisfies the whitespace
        // alternative anyway, so both engines agree.
        assertEquals(
            listOf("/sessions/abc"),
            SessionPathLinks.detectBareSessionCitations("check /sessions/abc").map { it.display },
        )
        assertEquals(
            listOf("/sessions/abc"),
            SessionPathLinks.detectBareSessionCitations("check /sessions/abc\n").map { it.display },
        )
        // The sentence period is NOT part of the citation (`.tsx` tails).
        val withPeriod = SessionPathLinks.detectBareSessionCitations("done. see /sessions/abc.")
        assertEquals(listOf("/sessions/abc"), withPeriod.map { it.display })
        assertEquals("/sessions/abc", "done. see /sessions/abc.".substring(withPeriod.single().range))
    }

    @Test
    fun `does not steal source paths under a sessions directory`() {
        assertTrue(
            SessionPathLinks.detectBareSessionCitations(
                "lives in web/src/routes/sessions/chat.tsx for this view",
            ).isEmpty(),
        )
    }

    @Test
    fun `ignores non-session paths`() {
        assertTrue(
            SessionPathLinks.detectBareSessionCitations("see /settings/general and ./src/foo.ts").isEmpty(),
        )
    }

    @Test
    fun `detects base-url prefixed and dot-slash citations`() {
        assertEquals(
            listOf("abc-def"),
            SessionPathLinks.detectBareSessionCitations("hubs/main/sessions/abc-def here").map { it.sessionId },
        )
        assertEquals(
            listOf("abc-def"),
            SessionPathLinks.detectBareSessionCitations("./sessions/abc-def here").map { it.sessionId },
        )
    }

    @Test
    fun `requires a slash-delimited prefix boundary`() {
        // `aaa.` is not a prefix segment (those must end in `/`), and there is
        // no whitespace/paren boundary mid-word — nothing linkifies.
        assertTrue(SessionPathLinks.detectBareSessionCitations("aaa.sessions/abc").isEmpty())
        // Contrast: a proper slash-delimited prefix IS a citation.
        assertEquals(
            listOf("abc"),
            SessionPathLinks.detectBareSessionCitations("see a/sessions/abc").map { it.sessionId },
        )
    }

    @Test
    fun `keeps session and file-path detection disjoint on a mixed line`() {
        val text = "open /sessions/abc-def then src/a.ts"

        val citations = SessionPathLinks.detectBareSessionCitations(text)
        val files = MarkdownTransforms.detectFilePathLinks(text)

        assertEquals(1, citations.size)
        assertEquals(1, files.size)
        assertEquals("abc-def", citations.single().sessionId)
        assertEquals("src/a.ts", files.single().path)
        // Guards the Markdown.kt merge: ranges must not overlap.
        assertTrue(citations.single().range.last < files.single().range.first)
    }

    @Test
    fun `trivial text without a sessions path yields nothing`() {
        // Floor case: no 'sessions/' substring can never linkify. The stronger
        // invariant (explicit-link labels never reach the bare detector — the
        // Markdown.kt walker appends them with insideLink = true) lives in the
        // Compose module and is not exercisable from this pure-JVM suite.
        assertTrue(SessionPathLinks.detectBareSessionCitations("t").isEmpty())
    }
}

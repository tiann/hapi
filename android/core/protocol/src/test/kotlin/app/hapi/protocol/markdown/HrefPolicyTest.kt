package app.hapi.protocol.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HrefPolicyTest {

    @Test
    fun `iana safe schemes are allowed`() {
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("https://example.com/a"))
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("HTTPS://EXAMPLE.COM"))
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("http://10.0.0.2:3006"))
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("mailto:a@b.c"))
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("ircs://irc.libera.chat/kotlin"))
        assertEquals(HrefDecision.Allowed, HrefPolicy.classify("xmpp:user@host"))
    }

    @Test
    fun `deny-listed schemes are blocked`() {
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("javascript:alert(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("JaVaScRiPt:alert(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("data:text/html;base64,PGI+"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("vbscript:msgbox(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("file:///etc/passwd"))
    }

    @Test
    fun `scheme obfuscation bypasses are caught`() {
        // Control characters and whitespace inside the scheme are stripped the
        // way platform URL dispatch does.
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("java\nscript:alert(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("\tjavascript:alert(1)"))
        // Single- and double-percent-encoded separators.
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("javascript%3Aalert(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("javascript%253Aalert(1)"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("%6A%61vascript:alert(1)"))
    }

    @Test
    fun `custom schemes require confirmation`() {
        assertEquals(HrefDecision.ConfirmFirst("vscode"), HrefPolicy.classify("vscode://file/a.ts"))
        assertEquals(HrefDecision.ConfirmFirst("obsidian"), HrefPolicy.classify("obsidian://open?vault=x"))
        assertEquals(HrefDecision.ConfirmFirst("slack"), HrefPolicy.classify("slack://channel?id=1"))
    }

    @Test
    fun `scheme-less targets are inert on native`() {
        // No SPA router here: app routes, anchors, and protocol-relative URLs
        // from the web policy all fail closed (workspace files are handled by
        // rewriteExplicitLinkTarget before classify is consulted).
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify(""))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("/settings"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("docs/a.md"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("#anchor"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("//example.com/x"))
    }

    @Test
    fun `windows drive paths are never custom schemes`() {
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("C:\\Users\\a\\b.ts"))
        assertEquals(HrefDecision.Blocked, HrefPolicy.classify("c:/work/b.ts"))
    }

    @Test
    fun `hasScheme distinguishes schemes from path colons`() {
        assertTrue(HrefPolicy.hasScheme("mailto:a@b.c"))
        assertTrue(HrefPolicy.hasScheme("vscode://file/a"))
        assertFalse(HrefPolicy.hasScheme("docs/a.md"))
        assertFalse(HrefPolicy.hasScheme("/path:12"))
        assertFalse(HrefPolicy.hasScheme("#section"))
        assertFalse(HrefPolicy.hasScheme(":oops"))
    }

    @Test
    fun `normalizedScheme survives malformed escapes`() {
        // Invalid escape: decoding fails, the raw value is classified as-is
        // (matches the web try/catch-break loop).
        assertEquals("https", HrefPolicy.normalizedScheme("https://a%ZZb"))
    }
}

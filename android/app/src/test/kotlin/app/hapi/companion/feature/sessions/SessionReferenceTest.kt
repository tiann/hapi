package app.hapi.companion.feature.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Mirrors `web/src/lib/sessionReference.test.ts` cases for the clipboard
 * prose; the steer suffix must stay byte-identical to
 * `SESSION_REFERENCE_STEER_SUFFIX` in `shared/src/sessionCitation.ts` (the
 * agent-side firing predicate greps for it).
 */
class SessionReferenceTest {

    @Test
    fun `builds citation prose with a quoted title and hub path`() {
        val text = SessionReference.buildSessionReferenceText("Fix login bug", "abc123")
        assertEquals(
            "See session \"Fix login bug\" (/sessions/abc123) for context." + SessionReference.STEER_SUFFIX,
            text,
        )
        assertTrue(text.endsWith("."))
    }

    @Test
    fun `empty or missing titles fall back to the bare path form`() {
        assertEquals(
            "See HAPI session /sessions/abc123 for context." + SessionReference.STEER_SUFFIX,
            SessionReference.buildSessionReferenceText(null, "abc123"),
        )
        assertEquals(
            "See HAPI session /sessions/abc123 for context." + SessionReference.STEER_SUFFIX,
            SessionReference.buildSessionReferenceText("   ", "abc123"),
        )
    }

    @Test
    fun `titles are whitespace-collapsed and capped at 120 code points`() {
        assertEquals(
            "a b c",
            SessionReference.sanitizeSessionReferenceTitle("  a\n\tb   c  "),
        )
        val long = "x".repeat(200)
        assertEquals(120, SessionReference.sanitizeSessionReferenceTitle(long)!!.length)
        // A shorter title passes through untouched.
        assertEquals("short", SessionReference.sanitizeSessionReferenceTitle("short"))
        assertNull(SessionReference.sanitizeSessionReferenceTitle(null))
    }

    @Test
    fun `quotes inside the title are JSON-escaped`() {
        val text = SessionReference.buildSessionReferenceTitleOnly("say \"hi\" \\ done", "abc123")
        assertTrue(text.contains("\"say \\\"hi\\\" \\\\ done\""), text)
    }

    @Test
    fun `ids percent-encode like JS encodeURIComponent`() {
        assertEquals("/sessions/abc-DEF_123", SessionReference.buildSessionReferencePath("abc-DEF_123"))
        // Unreserved JS set survives; space and non-ASCII do not.
        assertEquals("/sessions/a%20b", SessionReference.buildSessionReferencePath("a b"))
        assertEquals("/sessions/%C3%A9", SessionReference.buildSessionReferencePath("é"))
        assertTrue(SessionReference.buildSessionReferencePath("a/b+c").let { it == "/sessions/a%2Fb%2Bc" })
    }

    @Test
    fun `steer suffix matches the shared citation constant`() {
        assertEquals(
            " HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file.",
            SessionReference.STEER_SUFFIX,
        )
        assertFalse(SessionReference.STEER_SUFFIX.isEmpty())
    }
}

/** Title-only helper for assertion readability (path form covered elsewhere). */
private fun SessionReference.buildSessionReferenceTitleOnly(title: String, sessionId: String): String =
    buildSessionReferenceText(title, sessionId)

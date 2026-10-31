package app.hapi.companion

import app.hapi.protocol.markdown.SessionPathLinks
import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Route builders must keep a decoded citation id inside ONE encoded
 * `{sessionId}` path segment: navigation matches deep-link routes against the
 * encoded URI and its argument group cannot span a literal `/`, then decodes
 * the matched group once (its `NavUriUtils.decode` == `Uri.decode`). A raw
 * `a/b` id interpolated as `chat/a/b` therefore matches nothing (the review
 * repro), while `chat/a%2Fb` matches `chat/{sessionId}` and delivers `a/b`.
 */
class RoutesTest {

    /** Stand-in for the navigation library's single `Uri.decode` pass. */
    private fun navDecodeSegment(segment: String): String {
        // The encoder only emits unreserved chars and %XX (no raw '+'), so
        // URLDecoder is an exact inverse here — same %XX-UTF-8 semantics.
        return URLDecoder.decode(segment, Charsets.UTF_8)
    }

    @Test
    fun `unreserved ids keep their literal route strings`() {
        // Hub session ids are UUID-shaped (unreserved chars only): existing
        // route strings must be byte-identical after this change.
        val id = "0e2b1d4a-9f7c-4b3e-8a1d-2c5f6b7e9a10"
        assertEquals("chat/$id", Routes.chat(id))
        assertEquals("chat/$id/files", Routes.files(id))
        assertEquals("chat/$id/scratchlist", Routes.scratchlist(id))
        assertTrue(Routes.fileViewer(id, "src/Main.kt").startsWith("chat/$id/file?path="))
    }

    @Test
    fun `special-character ids stay in one encoded route segment and round-trip`() {
        val ids = listOf("a/b", "a%2Fb", "b%c", "a b", "a/b%c d", "a?b#c", "title/标题")
        for (id in ids) {
            for (route in listOf(Routes.chat(id), Routes.files(id), Routes.scratchlist(id))) {
                val segment = route.removePrefix("chat/").substringBefore('/')
                assertFalse(segment.contains('/'), "segment escapes the {sessionId} group: $route")
                assertFalse(segment.contains(' '), "raw space breaks URI parsing: $route")
                assertEquals(id, navDecodeSegment(segment), "decode mismatch for route: $route")
            }
            val viewer = Routes.fileViewer(id, "a.kt")
            val viewerSegment = viewer.removePrefix("chat/").substringBefore('/')
            assertEquals(id, navDecodeSegment(viewerSegment))
        }
    }

    @Test
    fun `percent encoding follows rfc3986 unreserved with uppercase hex`() {
        assertEquals("a%2Fb", Routes.encodeRouteArg("a/b"))
        assertEquals("a%20b", Routes.encodeRouteArg("a b"))
        assertEquals("b%25c", Routes.encodeRouteArg("b%c"))
        assertEquals("a%3Fb%23c", Routes.encodeRouteArg("a?b#c"))
        assertEquals("A-z.09_~", Routes.encodeRouteArg("A-z.09_~"))
        // Multi-byte UTF-8 escapes per byte, like the web encodeURIComponent.
        assertEquals("%E6%A0%87%E9%A2%98", Routes.encodeRouteArg("标题"))
    }

}

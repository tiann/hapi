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

    @Test
    fun `citation href to route to argument is a closed round trip`() {
        // Markdown citation (parseSessionPathHref percent-decodes) -> navigate
        // (Routes.chat percent-encodes) -> navigation hands back the decoded
        // id once. Covers the id classes the review called out: `/`, `%`,
        // space.
        for (href in listOf("/sessions/a%2Fb", "/sessions/b%25c", "/sessions/a%20b")) {
            val id = SessionPathLinks.parseSessionPathHref(href)
            assertEquals(true, id != null, "href no longer parses: $href")
            val segment = Routes.chat(id!!).removePrefix("chat/")
            assertFalse(segment.contains('/'))
            assertEquals(id, navDecodeSegment(segment))
        }
    }

    @Test
    fun `nested citation chains keep one distinct entry per session and pop back in order`() {
        // A cites B, B cites C (push, launchSingleTop — Navigation.kt's
        // onOpenSession). Model of the NavHost back stack: push dedupes only
        // an IDENTICAL top route; Back pops entries in order. Special-char
        // ids at every level must keep their entries distinct and
        // round-trippable — before the encode fix `a/b` produced a route that
        // matched no destination at all.
        val idA = "sess/a"
        val idB = "b%c"
        val idC = "c d"

        val backStack = mutableListOf(Routes.HOME)
        fun push(route: String) {
            if (backStack.last() != route) backStack += route
        }

        push(Routes.chat(idA))
        push(Routes.chat(idB))
        push(Routes.chat(idC))
        assertEquals(
            listOf(Routes.HOME, Routes.chat(idA), Routes.chat(idB), Routes.chat(idC)),
            backStack,
        )

        // Re-citing the chat already on top dedupes (launchSingleTop).
        push(Routes.chat(idC))
        assertEquals(4, backStack.size)

        // Back chain: C → B → A, each entry still the same encoded route it
        // was pushed as (route equality is what popBackStack matches on).
        while (backStack.last() != Routes.HOME) backStack.removeAt(backStack.lastIndex)
        assertEquals(Routes.HOME, backStack.last())

        // Every pushed route still carries its full id in one segment.
        for (id in listOf(idA, idB, idC)) {
            val segment = Routes.chat(id).removePrefix("chat/")
            assertFalse(segment.contains('/'))
            assertEquals(id, navDecodeSegment(segment))
        }
    }
}

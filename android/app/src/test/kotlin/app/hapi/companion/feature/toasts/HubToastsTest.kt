package app.hapi.companion.feature.toasts

import app.hapi.companion.Routes
import app.hapi.protocol.wire.SyncEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Toast presentation mapping (web `ToastContainer` click semantics): session
 * id wins over url; the only mappable web url is `/sessions/<id>`; everything
 * else is display-only. Message joins title + body, dropping blank lines.
 */
class HubToastsTest {

    private fun toast(
        title: String = "Title",
        body: String = "Body",
        sessionId: String = "",
        url: String = "",
    ): SyncEvent.Toast = SyncEvent.Toast(
        data = SyncEvent.Toast.Data(title = title, body = body, sessionId = sessionId, url = url),
    )

    @Test
    fun `session id maps to the chat route and wins over url`() {
        assertEquals(Routes.chat("s-1"), HubToasts.routeFor(toast(sessionId = "s-1")))
        assertEquals(
            Routes.chat("s-1"),
            HubToasts.routeFor(toast(sessionId = "s-1", url = "/sessions/s-other")),
        )
    }

    @Test
    fun `web session urls map to chat with query fragment and sub-paths tolerated`() {
        assertEquals(Routes.chat("s-2"), HubToasts.routeFor(toast(url = "/sessions/s-2")))
        assertEquals(Routes.chat("s-3"), HubToasts.routeFor(toast(url = "/sessions/s-3?x=1#frag")))
        assertEquals(Routes.chat("s-4"), HubToasts.routeFor(toast(url = "/sessions/s-4/files")))
    }

    @Test
    fun `unknown urls and empty payloads are display-only`() {
        assertNull(HubToasts.routeFor(toast())) // no session id, no url
        assertNull(HubToasts.routeFor(toast(url = "/settings/voice"))) // web-only route
        assertNull(HubToasts.routeFor(toast(url = "https://example.com/sessions/s-9"))) // not a SPA path
        assertNull(HubToasts.routeFor(toast(url = "/sessions/"))) // session id slot empty
        assertNull(HubToasts.routeFor(toast(url = "/sessions"))) // not the sessions route
    }

    @Test
    fun `message joins title and body and drops blank lines`() {
        assertEquals("Title\nBody", HubToasts.message(toast(title = "Title", body = "Body")))
        assertEquals("Title", HubToasts.message(toast(title = "Title", body = "")))
        assertEquals("Body", HubToasts.message(toast(title = "  ", body = "Body")))
        assertEquals("", HubToasts.message(toast(title = "", body = "")))
    }

    @Test
    fun `duration matches the web toast constant`() {
        assertEquals(6_000L, HubToasts.DURATION_MS)
    }
}

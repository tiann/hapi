package app.hapi.data.sse

import kotlin.test.Test
import kotlin.test.assertEquals

class SseConnectionTest {

    @Test
    fun `builds the global subscription url`() {
        val url = buildEventsUrl(
            baseUrl = "https://hub.test/",
            token = "tok en+x",
            subscription = SseSubscriptionKey.Global,
            visibility = "visible",
            lastEventId = null,
        )
        assertEquals("https://hub.test/api/events?token=tok+en%2Bx&visibility=visible&all=true", url)
    }

    @Test
    fun `builds the session subscription url with an encoded cursor`() {
        val url = buildEventsUrl(
            baseUrl = "https://hub.test",
            token = "t",
            subscription = SseSubscriptionKey.Session("s-1"),
            visibility = "hidden",
            lastEventId = "018f3c2a:412:9b1f00aa",
        )
        assertEquals(
            "https://hub.test/api/events?token=t&visibility=hidden&sessionId=s-1&lastEventId=018f3c2a%3A412%3A9b1f00aa",
            url,
        )
    }

    @Test
    fun `subscription keys match the plan's contract strings`() {
        assertEquals("global", SseSubscriptionKey.Global.key)
        assertEquals("session:s-1", SseSubscriptionKey.Session("s-1").key)
    }
}

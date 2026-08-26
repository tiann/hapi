package app.hapi.data.push

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Contract-side decoding of the FCM data payload
 * (`docs/api/native-companion-contract.md`; producer
 * `hub/src/fcm/fcmNotificationChannel.ts`): key parsing, channel routing,
 * coalescing tags, severity/contract-version tolerance, notifySummary
 * handling, and the suppress-when-open rule.
 */
class PushPayloadTest {

    private fun permissionData(vararg overrides: Pair<String, String>): Map<String, String> {
        val base = mutableMapOf(
            "type" to "permission-request",
            "sessionId" to "11111111-2222-3333-4444-555555555555",
            "sessionName" to "Claude - hapi",
            "url" to "/sessions/11111111-2222-3333-4444-555555555555",
            "requestId" to "req-1",
            "title" to "Permission Request",
            "body" to "Claude Edit: hub/server.ts\nSession: Claude - hapi",
            "severity" to "warning",
            "contractVersion" to "1",
        )
        overrides.forEach { (k, v) -> base[k] = v }
        return base
    }

    // ------------------------------------------------------------- parsing --

    @Test
    fun `permission-request parses every contract key`() {
        val payload = PushPayload.parse(permissionData())!!

        assertEquals(PushType.PERMISSION_REQUEST, payload.type)
        assertEquals("permission-request", payload.rawType)
        assertEquals("11111111-2222-3333-4444-555555555555", payload.sessionId)
        assertEquals("Claude - hapi", payload.sessionName)
        assertEquals("/sessions/11111111-2222-3333-4444-555555555555", payload.url)
        assertEquals("req-1", payload.requestId)
        assertEquals("Permission Request", payload.title)
        assertEquals(PushSeverity.WARNING, payload.severity)
        assertEquals("1", payload.contractVersion)
        assertTrue(payload.isKnownContractVersion)
        assertTrue(payload.supportsActions)
    }

    @Test
    fun `missing sessionId rejects the message`() {
        assertNull(PushPayload.parse(mapOf("type" to "ready", "title" to "t", "body" to "b")))
        assertNull(PushPayload.parse(permissionData("sessionId" to "")))
    }

    @Test
    fun `all severities decode and unknown severity degrades to null`() {
        assertEquals(PushSeverity.INFO, PushPayload.parse(permissionData("severity" to "info"))!!.severity)
        assertEquals(PushSeverity.SUCCESS, PushPayload.parse(permissionData("severity" to "success"))!!.severity)
        assertEquals(PushSeverity.WARNING, PushPayload.parse(permissionData("severity" to "warning"))!!.severity)
        assertEquals(PushSeverity.ERROR, PushPayload.parse(permissionData("severity" to "error"))!!.severity)
        assertNull(PushPayload.parse(permissionData("severity" to "catastrophic"))!!.severity)
        assertNull(PushPayload.parse(permissionData().minus("severity"))!!.severity)
    }

    // ----------------------------------------------------- channel routing --

    @Test
    fun `channel routing per type`() {
        assertEquals(
            PushPayload.CHANNEL_PERMISSION_REQUESTS,
            PushPayload.parse(permissionData())!!.channelId,
        )
        assertEquals(
            PushPayload.CHANNEL_READY,
            PushPayload.parse(permissionData("type" to "ready"))!!.channelId,
        )
        assertEquals(
            PushPayload.CHANNEL_TASK_NOTIFICATIONS,
            PushPayload.parse(permissionData("type" to "task-notification"))!!.channelId,
        )
    }

    @Test
    fun `unknown type still renders but routes to the default channel without actions`() {
        val payload = PushPayload.parse(permissionData("type" to "mystery-event"))!!

        assertNull(payload.type)
        assertEquals("mystery-event", payload.rawType)
        assertEquals(PushPayload.CHANNEL_TASK_NOTIFICATIONS, payload.channelId)
        assertEquals("mystery-event-11111111-2222-3333-4444-555555555555", payload.notificationTag)
        assertEquals("Permission Request", payload.displayTitle)
        assertFalse(payload.supportsActions)
    }

    @Test
    fun `unknown contractVersion renders title-body only`() {
        val payload = PushPayload.parse(permissionData("contractVersion" to "2"))!!

        assertFalse(payload.isKnownContractVersion)
        assertFalse(payload.supportsActions) // v2 action semantics are unknowable
        assertEquals(PushPayload.CHANNEL_TASK_NOTIFICATIONS, payload.channelId) // never heads-up
        assertEquals("Permission Request", payload.displayTitle)
        assertEquals("Claude Edit: hub/server.ts\nSession: Claude - hapi", payload.displayBody)
    }

    @Test
    fun `permission request without requestId cannot offer actions`() {
        val payload = PushPayload.parse(permissionData().minus("requestId"))!!
        assertFalse(payload.supportsActions)
    }

    // ------------------------------------------------------------ coalescing --

    @Test
    fun `tag is type-sessionId for coalescing`() {
        assertEquals(
            "permission-request-11111111-2222-3333-4444-555555555555",
            PushPayload.parse(permissionData())!!.notificationTag,
        )
        assertEquals(
            "ready-11111111-2222-3333-4444-555555555555",
            PushPayload.parse(permissionData("type" to "ready"))!!.notificationTag,
        )
    }

    // ---------------------------------------------------------- ready bodies --

    @Test
    fun `ready body prefers parsed notifySummary with distinct action line`() {
        val payload = PushPayload.parse(
            permissionData(
                "type" to "ready",
                "notifySummary" to
                    """{"version":1,"summary":"Fixed the flaky test","action":"Review the diff","status":"done"}""",
            )
        )!!

        assertEquals(1, payload.notifySummary?.version)
        assertEquals("Fixed the flaky test", payload.notifySummary?.summary)
        assertEquals("done", payload.notifySummary?.status)
        assertEquals("Fixed the flaky test\n-> Review the diff", payload.displayBody)
    }

    @Test
    fun `ready summary equal to action collapses to one line`() {
        val payload = PushPayload.parse(
            permissionData(
                "type" to "ready",
                "notifySummary" to """{"summary":"Ship it","action":"Ship it"}""",
            )
        )!!
        assertEquals("Ship it", payload.displayBody)
    }

    @Test
    fun `malformed notifySummary falls back to the hub-composed body`() {
        val payload = PushPayload.parse(
            permissionData("type" to "ready", "notifySummary" to "{not json"),
        )!!
        assertNull(payload.notifySummary)
        assertEquals("Claude Edit: hub/server.ts\nSession: Claude - hapi", payload.displayBody)
    }

    @Test
    fun `notifySummary on non-ready types never overrides the body`() {
        val payload = PushPayload.parse(
            permissionData("notifySummary" to """{"summary":"irrelevant"}"""),
        )!!
        assertEquals("Claude Edit: hub/server.ts\nSession: Claude - hapi", payload.displayBody)
    }

    @Test
    fun `blank title falls back to session name`() {
        val payload = PushPayload.parse(permissionData("title" to ""))!!
        assertEquals("Claude - hapi", payload.displayTitle)
    }

    // ---------------------------------------------------- suppress-when-open --

    @Test
    fun `suppresses only when foreground with that exact session open`() {
        assertTrue(shouldSuppressPush(appForeground = true, openChatSessionId = "s1", payloadSessionId = "s1"))
        assertFalse(shouldSuppressPush(appForeground = false, openChatSessionId = "s1", payloadSessionId = "s1"))
        assertFalse(shouldSuppressPush(appForeground = true, openChatSessionId = "s2", payloadSessionId = "s1"))
        assertFalse(shouldSuppressPush(appForeground = true, openChatSessionId = null, payloadSessionId = "s1"))
    }
}

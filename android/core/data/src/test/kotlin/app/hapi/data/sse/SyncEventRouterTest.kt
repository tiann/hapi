package app.hapi.data.sse

import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncEventRouterTest {

    private class RecordingTargets : SyncTargets {
        val calls = mutableListOf<String>()

        override fun onSessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {
            calls += "session/${event::class.simpleName}"
        }

        override fun onMachineEvent(scope: SseSubscriptionKey, event: SyncEvent.MachineUpdated) {
            calls += "machine/${event::class.simpleName}"
        }

        override fun onMessageEvent(scope: SseSubscriptionKey, event: SyncEvent) {
            calls += "message/${event::class.simpleName}"
        }

        override fun onToast(event: SyncEvent.Toast) {
            calls += "toast"
        }

        override fun requestFullResync(scope: SseSubscriptionKey) {
            calls += "resync/${scope.key}"
        }
    }

    private fun sync(json: String): EngineEvent.Sync {
        val parsed = SyncEvents.parse(json)
        return EngineEvent.Sync(parsed)
    }

    @Test
    fun `maps the full 13-type union onto its targets`() {
        val targets = RecordingTargets()
        val router = SyncEventRouter(targets)
        val scope = SseSubscriptionKey.Global

        listOf(
            """{"type":"session-added","sessionId":"s-1"}""",
            """{"type":"session-updated","sessionId":"s-1","data":{"active":true}}""",
            """{"type":"session-removed","sessionId":"s-1"}""",
            """{"type":"session-ended","sessionId":"s-1","reason":"completed"}""",
            """{"type":"message-received","sessionId":"s-1","message":{"id":"m-1","createdAt":1000,"content":{"role":"user","content":{"type":"text","text":"hi"}}}}""",
            """{"type":"messages-invalidated","sessionId":"s-1"}""",
            """{"type":"scheduled-matured","sessionId":"s-1"}""",
            """{"type":"messages-consumed","sessionId":"s-1","localIds":["l-1"],"invokedAt":2000}""",
            """{"type":"message-cancelled","sessionId":"s-1","messageId":"m-1"}""",
            """{"type":"machine-updated","machineId":"m-1"}""",
            """{"type":"toast","data":{"title":"t","body":"b","sessionId":"s-1","url":"/s/s-1"}}""",
            """{"type":"heartbeat","data":{"timestamp":1}}""",
            """{"type":"connection-changed","data":{"status":"connected"}}""",
        ).forEach { router.route(scope, sync(it)) }

        assertEquals(
            listOf(
                "session/SessionAdded",
                "session/SessionUpdated",
                "session/SessionRemoved",
                "session/SessionEnded",
                "message/MessageReceived",
                "message/MessagesInvalidated",
                "message/ScheduledMatured",
                "message/MessagesConsumed",
                "message/MessageCancelled",
                "machine/MachineUpdated",
                "toast",
                // heartbeat / connection-changed are engine-internal no-ops
            ),
            targets.calls,
        )
    }

    @Test
    fun `handshake gap requests a full resync for its scope while ok does not`() {
        val targets = RecordingTargets()
        val router = SyncEventRouter(targets)

        router.route(
            SseSubscriptionKey.Session("s-9"),
            EngineEvent.Handshake(subscriptionId = "sub-1", resume = EngineEvent.Resume.Gap),
        )
        assertEquals(listOf("resync/session:s-9"), targets.calls)

        router.route(
            SseSubscriptionKey.Global,
            EngineEvent.Handshake(subscriptionId = "sub-2", resume = EngineEvent.Resume.Ok),
        )
        assertEquals(listOf("resync/session:s-9"), targets.calls, "resume ok must skip the resync")
    }

    @Test
    fun `unknown and undecodable events are ignored`() {
        val targets = RecordingTargets()
        val router = SyncEventRouter(targets)
        router.route(SseSubscriptionKey.Global, sync("""{"type":"from-the-future","x":1}"""))
        router.route(SseSubscriptionKey.Global, sync("""{broken json"""))
        assertTrue(targets.calls.isEmpty())
    }
}

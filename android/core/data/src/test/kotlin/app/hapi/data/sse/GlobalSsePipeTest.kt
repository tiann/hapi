package app.hapi.data.sse

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest

/**
 * The hub-lifetime global pipe (B-M3ab): subscribes the engine's global key,
 * routes handshake verdicts (gap → full resync; every handshake → the
 * visibility hook) and sync events into [SyncTargets].
 */
class GlobalSsePipeTest {

    private class RecordingTargets : SyncTargets {
        val calls = MutableStateFlow<List<String>>(emptyList())

        private fun record(call: String) {
            calls.value = calls.value + call
        }

        override fun onSessionEvent(scope: SseSubscriptionKey, event: app.hapi.protocol.wire.SyncEvent) =
            record("session:${event::class.simpleName}")

        override fun onMachineEvent(scope: SseSubscriptionKey, event: app.hapi.protocol.wire.SyncEvent.MachineUpdated) =
            record("machine")

        override fun onMessageEvent(scope: SseSubscriptionKey, event: app.hapi.protocol.wire.SyncEvent) =
            record("message:${event::class.simpleName}")

        override fun onToast(event: app.hapi.protocol.wire.SyncEvent.Toast) = record("toast")

        override fun onHandshake(scope: SseSubscriptionKey, subscriptionId: String?) =
            record("handshake:${scope.key}:$subscriptionId")

        override fun requestFullResync(scope: SseSubscriptionKey) = record("resync:${scope.key}")
    }

    private fun transport(resume: String, vararg frames: String): SseTransport = object : SseTransport {
        override fun open(url: String, lastEventId: String?) = flow {
            emit(TransportEvent.Connected)
            emit(
                TransportEvent.Event(
                    SseRawEvent(
                        id = null,
                        data = """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"sub-9","resume":"$resume"}}""",
                    ),
                ),
            )
            frames.forEachIndexed { index, frame ->
                emit(TransportEvent.Event(SseRawEvent(id = "f$index", data = frame)))
            }
            awaitCancellation()
        }
    }

    @Test
    fun `gap handshake requests a full resync and reports the subscription id`() = runTest {
        val targets = RecordingTargets()
        val engine = SseEngine(
            baseUrl = "http://hub.test",
            transport = transport("gap"),
            tokenProvider = { "jwt" },
            scope = backgroundScope,
        )
        val pipe = GlobalSsePipe(engine, targets, backgroundScope)
        pipe.start()

        targets.calls.first { "resync:global" in it }
        assertTrue(targets.calls.value.contains("handshake:global:sub-9"))
        pipe.stop()
    }

    @Test
    fun `ok handshake routes events without a resync`() = runTest {
        val targets = RecordingTargets()
        val engine = SseEngine(
            baseUrl = "http://hub.test",
            transport = transport(
                "ok",
                """{"type":"messages-consumed","sessionId":"s1","localIds":["l1"],"invokedAt":123}""",
            ),
            tokenProvider = { "jwt" },
            scope = backgroundScope,
        )
        val pipe = GlobalSsePipe(engine, targets, backgroundScope)
        pipe.start()

        targets.calls.first { calls -> calls.any { it.startsWith("message:MessagesConsumed") } }
        assertFalse(targets.calls.value.any { it.startsWith("resync") })
        assertEquals("handshake:global:sub-9", targets.calls.value.first())
        pipe.stop()
    }
}

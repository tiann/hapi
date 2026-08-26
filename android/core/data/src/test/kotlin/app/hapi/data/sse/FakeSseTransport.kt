package app.hapi.data.sse

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/**
 * In-memory [SseTransport]: every collection of [open] registers a
 * [FakeConnection] on [opened] and then replays whatever the test feeds into
 * it. Closing the connection's channel completes the flow (clean EOF);
 * [FakeConnection.fail] materializes a failure first, mirroring the real
 * transport's contract.
 */
class FakeSseTransport : SseTransport {

    val opened = Channel<FakeConnection>(Channel.UNLIMITED)

    override fun open(url: String, lastEventId: String?): Flow<TransportEvent> = flow {
        val connection = FakeConnection(url, lastEventId)
        opened.send(connection)
        try {
            for (event in connection.incoming) {
                emit(event)
            }
        } finally {
            connection.closed = true
        }
    }

    class FakeConnection(
        val url: String,
        val lastEventId: String?,
    ) {
        val incoming = Channel<TransportEvent>(Channel.UNLIMITED)

        /** True once the engine stopped collecting (cancel, failure, or EOF). */
        @Volatile
        var closed: Boolean = false

        suspend fun connect() {
            incoming.send(TransportEvent.Connected)
        }

        /** [connect] + the `connection-changed {status:connected}` frame (no id). */
        suspend fun handshake(resume: String? = "ok", subscriptionId: String = "sub-1") {
            connect()
            val resumeField = if (resume != null) ""","resume":"$resume"""" else ""
            event(
                id = null,
                data = """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"$subscriptionId"$resumeField}}""",
            )
        }

        suspend fun event(id: String?, data: String) {
            incoming.send(TransportEvent.Event(SseRawEvent(id = id, data = data)))
        }

        /** Heartbeat frames carry no id on the wire. */
        suspend fun heartbeat() {
            event(id = null, data = """{"type":"heartbeat","data":{"timestamp":1}}""")
        }

        suspend fun fail(code: Int?) {
            incoming.send(TransportEvent.Failure(code))
            incoming.close()
        }

        /** Clean server EOF: flow completes without a Failure. */
        fun finish() {
            incoming.close()
        }
    }
}

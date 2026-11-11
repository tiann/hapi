package app.hapi.companion.feature.agentterminal

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * SocketIoAgentTerminalGateway event mapping: only `agent-terminal:output`
 * payloads whose terminalId is the literal 'agent' (the web hook filter)
 * surface as Output; everything else the room carries is dropped silently.
 * The gateway is driven through its SocketIoListener seam directly — no
 * socket, no I/O.
 */
class AgentTerminalGatewayTest {

    private class RecordingListener : AgentTerminalEventListener {
        val events = mutableListOf<AgentTerminalGatewayEvent>()
        override fun onEvent(event: AgentTerminalGatewayEvent) {
            events += event
        }
    }

    private val listener = RecordingListener()
    private val gateway = SocketIoAgentTerminalGateway(
        baseUrl = "https://hub.example.test",
        sessionId = "sess-1",
        tokenProvider = { "jwt" },
        listener = listener,
        // Constructed but never connected: only onEvent is driven below.
        scope = CoroutineScope(Dispatchers.Unconfined),
    )

    @Test
    fun agentOutputSurfacesAsOutputEvent() {
        gateway.onEvent("/terminal", "agent-terminal:output", buildJsonObject {
            put("sessionId", "sess-1")
            put("terminalId", "agent")
            put("data", "hello from the PTY")
        })
        assertEquals(
            listOf<AgentTerminalGatewayEvent>(AgentTerminalGatewayEvent.Output("hello from the PTY")),
            listener.events,
        )
    }

    @Test
    fun foreignTerminalIdIsDropped() {
        gateway.onEvent("/terminal", "agent-terminal:output", buildJsonObject {
            put("sessionId", "sess-1")
            put("terminalId", "term-other-viewer")
            put("data", "noise")
        })
        assertEquals(emptyList<AgentTerminalGatewayEvent>(), listener.events)
    }

    @Test
    fun missingDataOrNullPayloadIsDropped() {
        gateway.onEvent("/terminal", "agent-terminal:output", buildJsonObject {
            put("sessionId", "sess-1")
            put("terminalId", "agent")
        })
        gateway.onEvent("/terminal", "agent-terminal:output", null)
        assertEquals(emptyList<AgentTerminalGatewayEvent>(), listener.events)
    }

    @Test
    fun unrelatedEventsAreIgnoredButLifecycleForwarded() {
        gateway.onEvent("/terminal", "agent-terminal:reset", buildJsonObject { put("sessionId", "sess-1") })
        gateway.onEvent("/terminal", "terminal:output", buildJsonObject { put("terminalId", "agent") })
        assertTrue(listener.events.isEmpty())

        gateway.onNamespaceConnected("/terminal")
        gateway.onNamespaceConnectError("/terminal", "invalid token")
        gateway.onDisconnected("ping timeout")
        assertEquals(
            listOf(
                AgentTerminalGatewayEvent.NamespaceConnected,
                AgentTerminalGatewayEvent.ConnectError("invalid token"),
                AgentTerminalGatewayEvent.Disconnected("ping timeout"),
            ) as List<AgentTerminalGatewayEvent>,
            listener.events,
        )
    }
}

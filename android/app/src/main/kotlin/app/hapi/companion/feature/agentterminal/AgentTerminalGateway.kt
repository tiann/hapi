package app.hapi.companion.feature.agentterminal

import app.hapi.companion.feature.terminal.SocketIoClient
import app.hapi.companion.feature.terminal.SocketIoListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

/**
 * Agent-terminal traffic on the `/terminal` socket.io namespace
 * (`hub/src/socket/handlers/terminal.ts`, `agent-terminal:*` events). Unlike the
 * user terminal there is no per-viewer terminalId and no create/ready/exit
 * lifecycle: the agent PTY is the session's single TUI, keyed by sessionId, and
 * viewers come and go via subscribe/unsubscribe room membership.
 */
sealed interface AgentTerminalGatewayEvent {
    /**
     * Namespace CONNECT handshake succeeded (first connect or automatic
     * reconnect — the hub does NOT replay on its own; the listener re-emits
     * `agent-terminal:subscribe` when it still wants the stream).
     */
    data object NamespaceConnected : AgentTerminalGatewayEvent

    /**
     * `agent-terminal:output` with `terminalId == "agent"` — raw PTY bytes
     * (live stream, CLI repaint after refresh, or the hub-buffer replay the
     * hub unicasts when no CLI can repaint).
     */
    data class Output(val data: String) : AgentTerminalGatewayEvent

    /** Namespace auth rejected (hub middleware message). */
    data class ConnectError(val message: String) : AgentTerminalGatewayEvent

    /** Transport lost after having been open (the client auto-reconnects). */
    data class Disconnected(val reason: String) : AgentTerminalGatewayEvent
}

/** Callback the gateway reports events on; called sequentially, never concurrently. */
fun interface AgentTerminalEventListener {
    fun onEvent(event: AgentTerminalGatewayEvent)
}

/**
 * VM-facing seam over the agent-terminal socket: connect lifecycle plus the
 * four viewer→hub emits. All emits are fire-and-forget and silently dropped
 * while the namespace is not connected — the hub answers nothing (no acks; a
 * rejected subscribe is dropped silently to prevent session enumeration), so
 * the UI infers liveness from [AgentTerminalGatewayEvent.Output] alone.
 */
interface AgentTerminalGateway {
    /** Starts connecting (idempotent; also revives a given-up client). */
    fun connect()

    /** Stops for good (the hub's disconnect cleanup idles the stream server-side). */
    fun disconnect()

    /** True while the namespace handshake is complete (emit gate). */
    val isConnected: Boolean

    /** `agent-terminal:subscribe {sessionId}` — join the viewer room, trigger CLI repaint. */
    fun subscribe()

    /** `agent-terminal:unsubscribe {sessionId}` — leave; last viewer out stops the CLI stream. */
    fun unsubscribe()

    /** `agent-terminal:resize {sessionId, cols, rows}` — repaint the TUI at the viewer size. */
    fun resize(cols: Int, rows: Int)

    /** `agent-terminal:input {sessionId, data}` — raw keystrokes into the agent PTY. */
    fun sendInput(data: String)
}

/**
 * Production gateway: [AgentTerminalGateway] over the slice-B
 * [SocketIoClient] on the same `/terminal` namespace the user terminal uses
 * (one JWT middleware, one room family). Mirrors the web hook's output filter
 * exactly: only `terminalId === "agent"` payloads surface; anything else the
 * room carries (never happens today, defensive) is dropped. The
 * [tokenProvider] is re-invoked by the client on every attempt, so an expired
 * JWT self-heals.
 */
class SocketIoAgentTerminalGateway(
    baseUrl: String,
    private val sessionId: String,
    tokenProvider: suspend () -> String?,
    private val listener: AgentTerminalEventListener,
    scope: CoroutineScope,
    httpClient: OkHttpClient? = null,
) : AgentTerminalGateway, SocketIoListener {

    private val client = SocketIoClient(
        baseUrl = baseUrl,
        namespace = NAMESPACE,
        tokenProvider = tokenProvider,
        listener = this,
        scope = scope,
        httpClient = httpClient ?: defaultAgentGatewayClient(),
    )

    override val isConnected: Boolean
        get() = client.isNamespaceConnected

    override fun connect() = client.connect()

    override fun disconnect() = client.disconnect()

    override fun subscribe() {
        client.emit(
            "agent-terminal:subscribe",
            buildJsonObject { put("sessionId", sessionId) },
        )
    }

    override fun unsubscribe() {
        client.emit(
            "agent-terminal:unsubscribe",
            buildJsonObject { put("sessionId", sessionId) },
        )
    }

    override fun resize(cols: Int, rows: Int) {
        client.emit(
            "agent-terminal:resize",
            buildJsonObject {
                put("sessionId", sessionId)
                put("cols", cols)
                put("rows", rows)
            },
        )
    }

    override fun sendInput(data: String) {
        if (data.isEmpty()) return
        client.emit(
            "agent-terminal:input",
            buildJsonObject {
                put("sessionId", sessionId)
                put("data", data)
            },
        )
    }

    // -------------------------------------------------------- SocketIoListener --

    override fun onNamespaceConnected(namespace: String) {
        listener.onEvent(AgentTerminalGatewayEvent.NamespaceConnected)
    }

    override fun onNamespaceConnectError(namespace: String, message: String) {
        listener.onEvent(AgentTerminalGatewayEvent.ConnectError(message))
    }

    override fun onEvent(namespace: String, event: String, args: JsonObject?) {
        if (event != "agent-terminal:output") return
        val payload = args ?: return
        // Web hook filter: terminalId must be the literal 'agent' (the hub's
        // buffer replay reuses the same id, anything else is dropped).
        if (payload.stringField("terminalId") != AGENT_TERMINAL_ID) return
        val data = payload.stringField("data") ?: return
        listener.onEvent(AgentTerminalGatewayEvent.Output(data))
    }

    override fun onDisconnected(reason: String) {
        listener.onEvent(AgentTerminalGatewayEvent.Disconnected(reason))
    }

    private fun JsonObject.stringField(key: String): String? =
        runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

    private companion object {
        const val NAMESPACE = "/terminal"
        const val AGENT_TERMINAL_ID = "agent"
    }
}

/** Same transport policy as [SocketIoClient]'s default: connect-phase timeout only. */
private fun defaultAgentGatewayClient(): OkHttpClient =
    OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .pingInterval(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build()

package app.hapi.companion.feature.terminal

import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

/**
 * Terminal traffic crossing the `/terminal` socket.io namespace, as typed
 * events (hub contract: `hub/src/socket/handlers/terminal.ts`). Payloads carry
 * the viewer's [terminalId]; the ViewModel filters on its own id.
 */
sealed interface TerminalGatewayEvent {
    /**
     * Namespace CONNECT handshake succeeded (first connect or an automatic
     * reconnect — the hub replays the terminal buffer for a re-created id, so
     * the listener re-emits `terminal:create` on every occurrence).
     */
    data object NamespaceConnected : TerminalGatewayEvent

    /** `terminal:ready` — the PTY exists and output will flow. */
    data class Ready(val terminalId: String) : TerminalGatewayEvent

    /** `terminal:output` — raw PTY bytes to feed the emulator. */
    data class Output(val terminalId: String, val data: String) : TerminalGatewayEvent

    /** `terminal:exit` — the shell process ended. */
    data class Exit(val terminalId: String, val code: Int?, val signal: String?) : TerminalGatewayEvent

    /** `terminal:error` — hub-side refusal (inactive session, max terminals, …). */
    data class TerminalError(val terminalId: String, val message: String) : TerminalGatewayEvent

    /** Namespace auth rejected (hub middleware message). */
    data class ConnectError(val message: String) : TerminalGatewayEvent

    /** Transport lost after having been open (the client auto-reconnects). */
    data class Disconnected(val reason: String) : TerminalGatewayEvent
}

/** Callback the gateway reports events on; called sequentially, never concurrently. */
fun interface TerminalEventListener {
    fun onEvent(event: TerminalGatewayEvent)
}

/**
 * VM-facing seam over the terminal socket: connect lifecycle plus the four
 * client→hub emits (`terminal:create/write/resize/close` live behind
 * [createTerminal]/[write]/[resize]; the hub reaps on disconnect, so no
 * explicit close emit exists — matching the web hook, which never sends
 * `terminal:close`). All sends are fire-and-forget and safe to call while
 * disconnected (they drop, like the web `if (!socket.connected) return`).
 */
interface TerminalGateway {
    /** Starts connecting (idempotent; also revives a given-up client). */
    fun connect()

    /** Stops for good (no further auto-reconnects). */
    fun disconnect()

    /** True while the namespace handshake is complete (emit gate). */
    val isConnected: Boolean

    /** `terminal:create {sessionId, terminalId, cols, rows}` — also the reconnect/reattach emit. */
    fun createTerminal(terminalId: String, cols: Int, rows: Int)

    /** `terminal:write {terminalId, data}`. */
    fun write(terminalId: String, data: String)

    /** `terminal:resize {terminalId, cols, rows}`. */
    fun resize(terminalId: String, cols: Int, rows: Int)
}

/**
 * Production gateway: [TerminalGateway] over the slice-B [SocketIoClient] on
 * the `/terminal` namespace. Maps hub events to [TerminalGatewayEvent] and
 * serializes emits as socket.io EVENT frames. The [tokenProvider] is re-invoked
 * by the client on every attempt, so an expired JWT self-heals.
 */
class SocketIoTerminalGateway(
    baseUrl: String,
    private val sessionId: String,
    tokenProvider: suspend () -> String?,
    private val listener: TerminalEventListener,
    scope: CoroutineScope,
    httpClient: OkHttpClient? = null,
    backoffFirstMs: Long = 1_000,
    backoffMaxMs: Long = 5_000,
) : TerminalGateway, SocketIoListener {

    private val json = Json { ignoreUnknownKeys = true }

    private val client = SocketIoClient(
        baseUrl = baseUrl,
        namespace = NAMESPACE,
        tokenProvider = tokenProvider,
        listener = this,
        scope = scope,
        httpClient = httpClient ?: defaultGatewayClient(),
        backoffFirstMs = backoffFirstMs,
        backoffMaxMs = backoffMaxMs,
    )

    override val isConnected: Boolean
        get() = client.isNamespaceConnected

    override fun connect() = client.connect()

    override fun disconnect() = client.disconnect()

    override fun createTerminal(terminalId: String, cols: Int, rows: Int) {
        client.emit(
            "terminal:create",
            buildJsonObject {
                put("sessionId", sessionId)
                put("terminalId", terminalId)
                put("cols", cols)
                put("rows", rows)
            },
        )
    }

    override fun write(terminalId: String, data: String) {
        client.emit(
            "terminal:write",
            buildJsonObject {
                put("terminalId", terminalId)
                put("data", data)
            },
        )
    }

    override fun resize(terminalId: String, cols: Int, rows: Int) {
        client.emit(
            "terminal:resize",
            buildJsonObject {
                put("terminalId", terminalId)
                put("cols", cols)
                put("rows", rows)
            },
        )
    }

    // -------------------------------------------------------- SocketIoListener --

    override fun onNamespaceConnected(namespace: String) {
        listener.onEvent(TerminalGatewayEvent.NamespaceConnected)
    }

    override fun onNamespaceConnectError(namespace: String, message: String) {
        listener.onEvent(TerminalGatewayEvent.ConnectError(message))
    }

    override fun onEvent(namespace: String, event: String, args: JsonObject?) {
        val payload = args ?: return
        // Zod failures are dropped silently server-side; a payload without a
        // terminalId never reaches us, so a missing id here is a decode issue
        // and is ignored the same way.
        val terminalId = payload.stringField("terminalId") ?: return
        when (event) {
            "terminal:ready" -> listener.onEvent(TerminalGatewayEvent.Ready(terminalId))
            "terminal:output" -> {
                val data = payload.stringField("data") ?: return
                listener.onEvent(TerminalGatewayEvent.Output(terminalId, data))
            }
            "terminal:exit" -> listener.onEvent(
                TerminalGatewayEvent.Exit(
                    terminalId = terminalId,
                    code = payload["code"]?.jsonPrimitive?.intOrNull,
                    signal = payload.stringField("signal"),
                ),
            )
            "terminal:error" -> {
                val message = payload.stringField("message") ?: return
                listener.onEvent(TerminalGatewayEvent.TerminalError(terminalId, message))
            }
        }
    }

    override fun onDisconnected(reason: String) {
        listener.onEvent(TerminalGatewayEvent.Disconnected(reason))
    }

    private fun JsonObject.stringField(key: String): String? =
        runCatching { this[key]?.jsonPrimitive?.contentOrNull }.getOrNull()

    private companion object {
        const val NAMESPACE = "/terminal"
    }
}

/** Same transport policy as [SocketIoClient]'s default: connect-phase timeout only. */
private fun defaultGatewayClient(): OkHttpClient =
    OkHttpClient.Builder()
        .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
        .pingInterval(0, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build()

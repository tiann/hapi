package app.hapi.data.sse

import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * One raw SSE frame: the `id:` field (null when the frame carried none — the
 * okhttp reader keeps ids sticky per the SSE spec, so with the real transport
 * `id` repeats the previous value instead) and the `data:` payload (one
 * JSON-encoded `SyncEvent`, `docs/api/client-contract/sse.md#framing`).
 */
data class SseRawEvent(
    val id: String?,
    val data: String,
)

/** What a single connection attempt can report, in stream order. */
sealed interface TransportEvent {
    /** The HTTP response opened (2xx + `text/event-stream`). Precedes all events. */
    data object Connected : TransportEvent

    data class Event(val event: SseRawEvent) : TransportEvent

    /**
     * Terminal: the attempt failed (refused / non-2xx / mid-stream error).
     * [code] is the HTTP status when one was received (e.g. 401), else null.
     * The flow completes right after. A clean server EOF completes the flow
     * without a [Failure].
     */
    data class Failure(val code: Int?) : TransportEvent
}

/**
 * One SSE connection attempt as a cold flow. Collecting connects; cancelling
 * the collection tears the connection down. Implementations never throw into
 * the collector: errors are materialized as [TransportEvent.Failure] followed
 * by normal completion, so [SseEngine] stays free of transport exceptions
 * (and tests drive it with an in-memory fake).
 */
interface SseTransport {
    /**
     * @param lastEventId resume cursor, also sent as the `Last-Event-ID`
     *   header by the real transport (the header wins server-side over the
     *   `?lastEventId` query param that [buildEventsUrl] already appends).
     */
    fun open(url: String, lastEventId: String?): Flow<TransportEvent>
}

/** Which events a connection subscribes to; maps 1:1 onto the engine's key. */
sealed interface SseSubscriptionKey {
    /** Stable identity used for per-key cursor + connection bookkeeping. */
    val key: String

    /** `all=true`: every event in the token's namespace. */
    data object Global : SseSubscriptionKey {
        override val key: String get() = "global"
    }

    /** `sessionId=<id>`: the open chat's dedicated pipe. */
    data class Session(val sessionId: String) : SseSubscriptionKey {
        override val key: String get() = "session:$sessionId"
    }
}

/**
 * Builds `GET {base}/api/events?token=…&visibility=…&all=true|sessionId=…[&lastEventId=…]`
 * (`docs/api/client-contract/sse.md#endpoint`). `visibility` must be the
 * literal `visible` to count as visible; anything else is hidden.
 */
fun buildEventsUrl(
    baseUrl: String,
    token: String,
    subscription: SseSubscriptionKey,
    visibility: String,
    lastEventId: String?,
): String {
    val params = buildList {
        add("token" to token)
        add("visibility" to visibility)
        when (subscription) {
            is SseSubscriptionKey.Global -> add("all" to "true")
            is SseSubscriptionKey.Session -> add("sessionId" to subscription.sessionId)
        }
        if (lastEventId != null) {
            add("lastEventId" to lastEventId)
        }
    }
    val query = params.joinToString("&") { (name, value) ->
        "$name=${URLEncoder.encode(value, Charsets.UTF_8.name())}"
    }
    return "${baseUrl.trimEnd('/')}/api/events?$query"
}

/**
 * The production [SseTransport]: okhttp-sse over a dedicated client —
 * `readTimeout = 0` (the server is legitimately silent for up to 30 s between
 * heartbeats; staleness is the engine watchdog's job), no cache, and its own
 * [Dispatcher] so a long-lived stream never starves the REST client's pool.
 *
 * Gzip: the client deliberately does NOT set `Accept-Encoding`, so OkHttp
 * injects `gzip` itself and transparently inflates the response through a
 * streaming `GzipSource` — the hub sync-flushes after every event, and frames
 * surface per flush (pinned by `OkHttpSseTransportTest`). [acceptEncodingIdentity]
 * is the contract's escape hatch (`sse.md#gzip`): when set, requests
 * `Accept-Encoding: identity` and takes the uncompressed stream.
 */
class OkHttpSseTransport(
    baseClient: OkHttpClient = OkHttpClient(),
    private val acceptEncodingIdentity: Boolean = false,
) : SseTransport {

    private val client: OkHttpClient = baseClient.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(ReconnectPolicy.CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .cache(null)
        .dispatcher(Dispatcher())
        .build()

    override fun open(url: String, lastEventId: String?): Flow<TransportEvent> = callbackFlow {
        val request = Request.Builder()
            .url(url)
            .apply {
                if (lastEventId != null) {
                    header("Last-Event-ID", lastEventId)
                }
                if (acceptEncodingIdentity) {
                    header("Accept-Encoding", "identity")
                }
            }
            .build()

        val listener = object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                // Blocks okhttp's reader thread when the collector lags, so
                // backpressure reaches TCP instead of growing a queue.
                trySendBlocking(TransportEvent.Connected)
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                trySendBlocking(TransportEvent.Event(SseRawEvent(id = id, data = data)))
            }

            override fun onClosed(eventSource: EventSource) {
                channel.close()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                trySendBlocking(TransportEvent.Failure(response?.code))
                channel.close()
            }
        }

        val source = EventSources.createFactory(client).newEventSource(request, listener)
        awaitClose { source.cancel() }
    }
}

@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.chat.composer

import app.hapi.data.api.HapiApi
import java.io.IOException
import java.net.URLEncoder
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString

/**
 * Web `joinTranscriptParts`: trim each part, drop empties, join with single
 * spaces — the preview string both the interim flow and the final flush use.
 */
internal fun joinTranscriptParts(vararg parts: String): String =
    parts.map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")

/**
 * Pure deepgram streaming logic (web `startDeepgramRealtimeTranscription`),
 * wedged over two seams: a websocket ([ProviderSocketFactory]) and streaming
 * mic capture ([StreamingAudioSource]). JVM-testable end to end.
 *
 * Differences from the web, both pinned by the platform: audio is PCM16 mono
 * 16 kHz (`linear16` query params + [AudioRecordStreamingSource]) instead of
 * webm/opus, and the bearer subprotocol rides the
 * `Sec-WebSocket-Protocol` header ([OkHttpProviderSocketFactory]).
 */
internal class DeepgramRealtimeDictation(
    private val socketFactory: ProviderSocketFactory,
    private val audio: StreamingAudioSource,
) {
    suspend fun start(
        getToken: suspend () -> String,
        language: String?,
        callbacks: RealtimeTranscriptionCallbacks,
    ): RealtimeTranscriptionSession {
        val token = getToken()
        return Session(
            url = buildListenUrl(language),
            token = token,
            socketFactory = socketFactory,
            audio = audio,
            callbacks = callbacks,
        ).awaitConnected()
    }

    internal companion object {
        /** Web `DEEPGRAM_TRANSCRIPTION_MODEL`. */
        const val MODEL = "nova-3"
        const val CONNECT_TIMEOUT_MS = 10_000L

        /** Web stop-timeout: how long to wait for the finalized result. */
        const val STOP_TIMEOUT_MS = 2_500L

        internal fun buildListenUrl(language: String?): String = buildString {
            append("wss://api.deepgram.com/v1/listen")
            append("?model=").append(MODEL)
            append("&smart_format=true&interim_results=true&endpointing=false")
            append("&encoding=linear16&sample_rate=16000&channels=1")
            language?.let {
                append("&language=").append(URLEncoder.encode(it, "UTF-8"))
            }
        }
    }

    private class Session(
        url: String,
        token: String,
        socketFactory: ProviderSocketFactory,
        private val audio: StreamingAudioSource,
        private val callbacks: RealtimeTranscriptionCallbacks,
    ) : RealtimeTranscriptionSession {
        private val listener = object : ProviderSocketListener {
            override fun onOpen() {
                openedSocket = true
                audio.startCapture { chunk -> if (socket.isOpen) socket.send(chunk) }
                callbacks.onConnected()
                opened.complete(Unit)
            }

            override fun onMessage(text: String) = handle(text)

            override fun onClosed() {
                if (openedSocket) {
                    if (!done && !stopping) {
                        fail(IOException("Deepgram realtime transcription disconnected"))
                    }
                } else {
                    connectFailure.complete(IOException("Deepgram realtime transcription disconnected"))
                }
            }

            override fun onFailure(error: Throwable) {
                if (openedSocket) {
                    if (!done) fail(error)
                } else {
                    connectFailure.complete(error)
                }
            }
        }

        private val socket: ProviderSocket = socketFactory.open(url, token, listener)

        private val opened = CompletableDeferred<Unit>()
        private val connectFailure = CompletableDeferred<Throwable>()
        private val finishedSignal = CompletableDeferred<Unit>()

        @Volatile private var openedSocket = false
        @Volatile private var done = false
        @Volatile private var stopping = false
        @Volatile private var committed = ""
        @Volatile private var interim = ""

        /** Web connect await: open vs failure, 10 s cap; throws without callbacks. */
        suspend fun awaitConnected(): Session {
            try {
                val failure = withTimeout(CONNECT_TIMEOUT_MS) {
                    select<Throwable?> {
                        opened.onAwait { null }
                        connectFailure.onAwait { it }
                    }
                }
                if (failure != null) {
                    abandon()
                    throw failure
                }
                return this
            } catch (timeout: TimeoutCancellationException) {
                abandon()
                throw IOException("Deepgram realtime connection timed out", timeout)
            } catch (cancellation: CancellationException) {
                abandon()
                throw cancellation
            }
        }

        override suspend fun stop() {
            if (done || stopping) return
            stopping = true
            // Ordering contract: stopCapture flushes the final chunk before
            // returning, so Finalize lands after every audio byte (web sends
            // it from recorder.onstop).
            audio.stopCapture()
            if (!socket.isOpen) {
                finish(joinTranscriptParts(committed, interim))
                return
            }
            socket.send("""{"type":"Finalize"}""")
            withTimeoutOrNull(STOP_TIMEOUT_MS) { finishedSignal.await() }
                ?: finish(joinTranscriptParts(committed, interim))
        }

        override fun cancel() = abandon()

        private fun handle(raw: String) {
            val event = runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return
            when (event.string("type")) {
                "Error" -> fail(
                    RuntimeException(
                        event.string("description")?.takeIf { it.isNotEmpty() }
                            ?: "Deepgram realtime transcription failed",
                    ),
                )

                "Results" -> {
                    val alternative = ((event["channel"] as? JsonObject)
                        ?.get("alternatives") as? JsonArray)
                        ?.firstOrNull() as? JsonObject
                    val transcript = (alternative?.get("transcript") as? JsonPrimitive)?.contentOrNull ?: ""
                    if (event.bool("is_final") == true) {
                        committed = joinTranscriptParts(committed, transcript)
                        interim = ""
                    } else {
                        interim = transcript
                    }
                    val current = joinTranscriptParts(committed, interim)
                    callbacks.onPartial(current)
                    if (stopping && event.bool("is_final") == true && event.bool("from_finalize") == true) {
                        finish(current)
                    }
                }
            }
        }

        @Synchronized
        private fun finish(text: String) {
            if (done) return
            done = true
            cleanup()
            finishedSignal.complete(Unit)
            callbacks.onFinal(text)
        }

        @Synchronized
        private fun fail(error: Throwable) {
            if (done) return
            done = true
            cleanup()
            finishedSignal.complete(Unit)
            callbacks.onError(error)
        }

        @Synchronized
        private fun abandon() {
            if (done) return
            done = true
            cleanup()
            finishedSignal.complete(Unit)
        }

        @Synchronized
        private fun cleanup() {
            audio.release()
            if (socket.isOpen) socket.send("""{"type":"CloseStream"}""")
            socket.close()
        }

        private fun JsonObject.string(name: String): String? =
            (this[name] as? JsonPrimitive)?.contentOrNull

        private fun JsonObject.bool(name: String): Boolean? =
            (this[name] as? JsonPrimitive)?.booleanOrNull
    }
}

/**
 * Production engine: hub realtime-token → deepgram websocket over OkHttp with
 * PCM16 mic capture. The only realtime provider on Android in this slice.
 */
internal class DeepgramRealtimeDictationEngine(
    private val api: HapiApi,
    private val socketFactory: ProviderSocketFactory,
    private val audioFactory: () -> StreamingAudioSource,
) : RealtimeDictationEngine {
    override val supportedProviders: Set<String> = setOf("deepgram")

    override suspend fun start(
        provider: String,
        language: String?,
        callbacks: RealtimeTranscriptionCallbacks,
    ): RealtimeTranscriptionSession =
        DeepgramRealtimeDictation(socketFactory, audioFactory()).start(
            getToken = { api.fetchRealtimeTranscriptionToken(provider, language).token },
            language = language,
            callbacks = callbacks,
        )
}

/** Production websocket seam over OkHttp. */
internal class OkHttpProviderSocketFactory(private val client: OkHttpClient) : ProviderSocketFactory {
    override fun open(
        url: String,
        bearerToken: String,
        listener: ProviderSocketListener,
    ): ProviderSocket {
        val socket = OkHttpProviderSocket()
        val request = Request.Builder()
            .url(url)
            // OkHttp exposes no subprotocol API; deepgram accepts the raw
            // header form `bearer, <token>`.
            .header("Sec-WebSocket-Protocol", "bearer, $bearerToken")
            .build()
        val webSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    socket.markOpen()
                    listener.onOpen()
                }

                override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socket.markClosed()
                    listener.onClosed()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socket.markClosed()
                    listener.onFailure(t)
                }
            },
        )
        socket.attach(webSocket)
        return socket
    }
}

/**
 * OkHttp's [WebSocket] interface exposes no openness query, so the adapter
 * tracks it from the listener callbacks ([markOpen]/[markClosed]) — the same
 * contract the engine's fake socket implements.
 */
private class OkHttpProviderSocket : ProviderSocket {
    private var webSocket: WebSocket? = null

    @Volatile private var open = false

    fun attach(webSocket: WebSocket) {
        this.webSocket = webSocket
    }

    fun markOpen() {
        open = true
    }

    fun markClosed() {
        open = false
    }

    override val isOpen: Boolean get() = open
    override fun send(text: String) { webSocket?.send(text) }
    override fun send(bytes: ByteArray) { webSocket?.send(bytes.toByteString()) }
    override fun close() {
        open = false
        webSocket?.close(1000, null)
    }
}

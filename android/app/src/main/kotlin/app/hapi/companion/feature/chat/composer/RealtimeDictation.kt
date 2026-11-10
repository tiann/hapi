package app.hapi.companion.feature.chat.composer

/**
 * Streaming-dictation event model (web `realtimeTranscription.ts`
 * `RealtimeTranscriptionCallbacks`): [onPartial] carries the running
 * joined preview (committed + interim), [onFinal] the settled transcript
 * of the whole take. Slice C-③.
 */
interface RealtimeTranscriptionCallbacks {
    /** Transport + capture are up; the take is live. */
    fun onConnected()

    /** Running preview — committed finals plus the current interim hypothesis. */
    fun onPartial(text: String)

    /** The take settled; [text] is the full transcript. Fired at most once. */
    fun onFinal(text: String)

    /** The session died (transport, provider, or stop error). Terminal. */
    fun onError(error: Throwable)
}

/** A live streaming session (web `RealtimeTranscriptionSession`). */
interface RealtimeTranscriptionSession {
    /**
     * Flush the take: suspends until the final transcript lands (or the
     * provider gives up, bounded by a short timeout) and [RealtimeTranscriptionCallbacks.onFinal]
     * / [onError] has fired. A no-op once finished or already stopping.
     */
    suspend fun stop()

    /** Abandon the take — stop everything, emit no final transcript. */
    fun cancel()
}

/**
 * A provider-capable streaming engine. Ids come from
 * `GET /api/voice/transcription/providers` entries whose `modes` contain
 * `realtime`; Android drives deepgram only (openai is WebRTC, elevenlabs
 * needs its SDK — both omitted in this slice).
 */
interface RealtimeDictationEngine {
    /** Provider ids this engine can drive (e.g. `["deepgram"]`). */
    val supportedProviders: Set<String>

    /**
     * Open a streaming session. Throws when the connection cannot be
     * established (no callbacks fired); once a session is returned, every
     * subsequent outcome arrives through [callbacks].
     */
    suspend fun start(
        provider: String,
        language: String?,
        callbacks: RealtimeTranscriptionCallbacks,
    ): RealtimeTranscriptionSession
}

/** Events from one provider websocket. */
interface ProviderSocketListener {
    fun onOpen()
    fun onMessage(text: String)

    /** Closed cleanly (or by our own close). */
    fun onClosed()

    /** Transport-level failure. */
    fun onFailure(error: Throwable)
}

/** Seam over one provider websocket (production: OkHttp; tests: scripted). */
interface ProviderSocket {
    val isOpen: Boolean
    fun send(text: String)
    fun send(bytes: ByteArray)
    fun close()
}

/** Seam over websocket construction (keeps engine logic JVM-testable). */
interface ProviderSocketFactory {
    /** The [bearerToken] travels as the `bearer` subprotocol (deepgram). */
    fun open(url: String, bearerToken: String, listener: ProviderSocketListener): ProviderSocket
}

/**
 * Seam over streaming mic capture (production: AudioRecord PCM16; tests:
 * scripted chunks). [startCapture] begins delivering chunks to [onChunk];
 * after [stopCapture] returns no further chunks are delivered (any final
 * chunk is flushed synchronously before it returns). [release] stops any
 * active capture and frees the microphone; the whole seam is single-take.
 */
interface StreamingAudioSource {
    fun startCapture(onChunk: (ByteArray) -> Unit)
    fun stopCapture()
    fun release()
}

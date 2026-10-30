package app.hapi.companion.feature.chat.composer

import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.TranscriptionProvidersResponse
import app.hapi.protocol.wire.TranscriptionResponse
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Append a finished transcript to the composer text with a single space
 * separator (web `appendTranscript`, `useDictation.ts`).
 */
fun appendTranscript(text: String, transcript: String): String {
    val addition = transcript.trim()
    if (addition.isEmpty()) return text
    if (text.isEmpty()) return addition
    val separator = if (text.last().isWhitespace()) "" else " "
    return "$text$separator$addition"
}

/** Transport seam over the hub's two dictation endpoints (fake in tests). */
interface DictationApi {
    /** `GET /api/voice/transcription/providers`. */
    suspend fun transcriptionProviders(): TranscriptionProvidersResponse

    /** `POST /api/voice/transcription` (multipart, `mode=standard`). */
    suspend fun transcribe(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?,
    ): TranscriptionResponse
}

/** Production [DictationApi] over [HapiApi]. */
class HapiDictationApi(private val api: HapiApi) : DictationApi {
    override suspend fun transcriptionProviders(): TranscriptionProvidersResponse =
        api.getTranscriptionProviders()

    override suspend fun transcribe(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?,
    ): TranscriptionResponse =
        api.transcribeVoice(audio, filename, mimeType, provider, mode = "standard", language = language)
}

/**
 * Recorder seam (production: [MediaRecorderDictation] — AAC/m4a via the
 * framework `MediaRecorder`; tests: scripted bytes).
 */
interface DictationRecorder {
    /** Container filename the produced audio should upload under (`speech.m4a`). */
    val filename: String

    /** MIME type of the produced audio (`audio/mp4`). */
    val mimeType: String

    /** Begin capturing; throws when the microphone cannot be opened. */
    fun start()

    /** Stop and finalize the take; the recorded bytes, or null when nothing usable was captured. */
    fun stop(): ByteArray?

    /** Abandon the take, discarding any captured data. */
    fun cancel()
}

/** The mic button / recording chip state machine. */
sealed interface DictationState {
    /** No take in progress — mic button shows the idle glyph. */
    data object Idle : DictationState

    /** Provider discovery / recorder spin-up after the first press. */
    data object Starting : DictationState

    /**
     * Capturing; the chip derives elapsed time from [startedAtMs]. [partial]
     * carries the streaming (interim) preview while a realtime take runs —
     * empty for standard (upload) dictation (slice C-③).
     */
    data class Recording(val startedAtMs: Long, val partial: String = "") : DictationState

    /** Final flush / upload + transcription in flight — mic button shows a spinner. */
    data object Transcribing : DictationState
}

/** One-shot dictation outcomes for the screen. */
sealed interface DictationEvent {
    /** Final transcript — append to the composer via [appendTranscript]. */
    data class Transcribed(val text: String) : DictationEvent

    /** The hub has no transcription provider configured. */
    data object NoProvider : DictationEvent

    /**
     * Recording or transcription failed (snackbar). [kind] localizes at the
     * UI layer; [detail] is server/exception text shown verbatim when present.
     */
    data class Error(val kind: DictationErrorKind, val detail: String? = null) : DictationEvent
}

/** Semantic dictation failure kinds (B-M5a) — resolved to strings by the UI. */
enum class DictationErrorKind {
    StartFailed,
    HubUnreachable,
    RecordingFailed,
    NoAudio,
    TranscriptionFailed,
}

/**
 * Press-to-toggle dictation (B-M3ce, realtime in C-③):
 * [refreshAvailability] discovers a provider on chat entry
 * (`GET /providers`, first entry supporting `realtime` when a
 * [realtimeEngine] can drive it, else first `standard`). The first [toggle]
 * reuses it (or discovers one) and starts the take — a streaming session for
 * realtime providers (interim previews land in
 * [DictationState.Recording.partial], the final transcript in
 * [DictationEvent.Transcribed]) or the recorder + `POST /api/voice/transcription`
 * otherwise. The second press stops the take; [cancel] abandons it.
 *
 * Web reference: `useDictation.ts` / `useRealtimeDictation.ts`. Android
 * drives deepgram only; no language override yet — the hub auto-detects.
 *
 * Plain constructor over seams — JVM tests drive it with fakes.
 */
class DictationController(
    private val api: DictationApi,
    private val recorder: DictationRecorder,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    /** Streaming engine; null = standard (upload) dictation only. */
    private val realtimeEngine: RealtimeDictationEngine? = null,
) {
    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state.asStateFlow()

    /** Hidden until the hub confirms a usable provider. */
    private val _isAvailable = MutableStateFlow(false)
    val isAvailable: StateFlow<Boolean> = _isAvailable.asStateFlow()

    private val _events = MutableSharedFlow<DictationEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<DictationEvent> = _events.asSharedFlow()

    /** Reused across takes; refreshed when the composer appears. */
    private var cachedChoice: ProviderChoice? = null

    /** Live streaming session while a realtime take runs. */
    private var realtimeSession: RealtimeTranscriptionSession? = null

    private var job: Job? = null
    private var refreshingAvailability = false

    /** `id` + whether the realtime engine drives it (else standard upload). */
    private data class ProviderChoice(val id: String, val realtime: Boolean)

    /** Web `RealtimeTranscriptionCallbacks` → state + events. */
    private val realtimeCallbacks = object : RealtimeTranscriptionCallbacks {
        override fun onConnected() {
            if (_state.value == DictationState.Starting) {
                _state.value = DictationState.Recording(now())
            }
        }

        override fun onPartial(text: String) {
            val current = _state.value as? DictationState.Recording ?: return
            _state.value = current.copy(partial = text)
        }

        override fun onFinal(text: String) {
            realtimeSession = null
            _events.tryEmit(DictationEvent.Transcribed(text))
            _state.value = DictationState.Idle
        }

        override fun onError(error: Throwable) {
            realtimeSession = null
            _events.tryEmit(DictationEvent.Error(DictationErrorKind.TranscriptionFailed, error.message))
            _state.value = DictationState.Idle
        }
    }

    /** Silent preflight; no microphone access or notices on chat entry. */
    suspend fun refreshAvailability() {
        if (_state.value != DictationState.Idle || refreshingAvailability) return
        refreshingAvailability = true
        cachedChoice = null
        _isAvailable.value = false
        try {
            cachedChoice = discoverProvider(reportErrors = false)
            _isAvailable.value = cachedChoice != null
        } finally {
            refreshingAvailability = false
        }
    }

    /** Mic button press: Idle → record, Recording → stop + transcribe. */
    fun toggle() {
        when (_state.value) {
            DictationState.Idle -> startRecording()
            is DictationState.Recording -> stopAndTranscribe()
            // Starting/Transcribing: an operation is already in flight.
            DictationState.Starting, DictationState.Transcribing -> Unit
        }
    }

    /** Recording chip ✕: discard the take (no upload, no final transcript). */
    fun cancel() {
        if (_state.value !is DictationState.Recording) return
        val session = realtimeSession
        realtimeSession = null
        if (session != null) runCatching { session.cancel() } else runCatching { recorder.cancel() }
        _state.value = DictationState.Idle
    }

    private fun startRecording() {
        if (job?.isActive == true || refreshingAvailability) return
        _state.value = DictationState.Starting
        job = scope.launch {
            val choice = cachedChoice ?: discoverProvider() ?: run {
                _state.value = DictationState.Idle
                return@launch
            }
            cachedChoice = choice
            _isAvailable.value = true
            if (choice.realtime && realtimeEngine != null) {
                startRealtime(choice.id)
            } else {
                startStandard()
            }
        }
    }

    private suspend fun startStandard() {
        try {
            recorder.start()
            _state.value = DictationState.Recording(now())
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            _events.tryEmit(DictationEvent.Error(DictationErrorKind.StartFailed, error.message))
            _state.value = DictationState.Idle
        }
    }

    private suspend fun startRealtime(providerId: String) {
        val engine = realtimeEngine ?: return startStandard()
        try {
            // Recording state lands via onConnected; connect failures throw
            // here (engine contract) and surface as a start error.
            realtimeSession = engine.start(providerId, null, realtimeCallbacks)
        } catch (cancellation: CancellationException) {
            runCatching { realtimeSession?.cancel() }
            realtimeSession = null
            throw cancellation
        } catch (error: Exception) {
            _events.tryEmit(DictationEvent.Error(DictationErrorKind.StartFailed, error.message))
            _state.value = DictationState.Idle
        }
    }

    /** @return the chosen provider, or null; preflight suppresses failure events. */
    private suspend fun discoverProvider(reportErrors: Boolean = true): ProviderChoice? {
        val providers = try {
            api.transcriptionProviders().providers
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            if (reportErrors) {
                _events.tryEmit(DictationEvent.Error(DictationErrorKind.HubUnreachable, error.message))
            }
            return null
        }
        // First realtime provider the engine can drive — streaming beats the
        // upload round-trip (web useRealtimeDictation); fall back to the
        // first standard entry. `browser-local` (web-only) never qualifies.
        val engine = realtimeEngine
        val chosen = providers.firstOrNull {
            it.modes.contains("realtime") && engine != null && engine.supportedProviders.contains(it.id)
        } ?: providers.firstOrNull { it.modes.contains("standard") }
        if (chosen == null && reportErrors) {
            _events.tryEmit(DictationEvent.NoProvider)
        }
        return chosen?.let { info ->
            val realtime = engine != null &&
                info.modes.contains("realtime") &&
                engine.supportedProviders.contains(info.id)
            ProviderChoice(info.id, realtime)
        }
    }

    private fun stopAndTranscribe() {
        val session = realtimeSession
        if (session != null) {
            _state.value = DictationState.Transcribing
            job = scope.launch {
                try {
                    // onFinal / onError land via the callbacks inside stop().
                    session.stop()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    _events.tryEmit(DictationEvent.Error(DictationErrorKind.TranscriptionFailed, error.message))
                } finally {
                    if (realtimeSession === session) realtimeSession = null
                    if (_state.value == DictationState.Transcribing) _state.value = DictationState.Idle
                }
            }
            return
        }
        val provider = cachedChoice?.id ?: return // unreachable: set before Recording
        _state.value = DictationState.Transcribing
        job = scope.launch {
            val audio = try {
                recorder.stop()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(DictationEvent.Error(DictationErrorKind.RecordingFailed, error.message))
                _state.value = DictationState.Idle
                return@launch
            }
            if (audio == null || audio.isEmpty()) {
                _events.tryEmit(DictationEvent.Error(DictationErrorKind.NoAudio))
                _state.value = DictationState.Idle
                return@launch
            }
            try {
                val result = api.transcribe(
                    audio = audio,
                    filename = recorder.filename,
                    mimeType = recorder.mimeType,
                    provider = provider,
                    language = null,
                )
                _events.tryEmit(DictationEvent.Transcribed(result.text))
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _events.tryEmit(DictationEvent.Error(DictationErrorKind.TranscriptionFailed, error.message))
            } finally {
                _state.value = DictationState.Idle
            }
        }
    }
}

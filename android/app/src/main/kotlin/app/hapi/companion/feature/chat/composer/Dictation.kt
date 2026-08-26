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

    /** Capturing; the chip derives elapsed time from [startedAtMs]. */
    data class Recording(val startedAtMs: Long) : DictationState

    /** Upload + transcription in flight — mic button shows a spinner. */
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
 * Press-to-toggle dictation (B-M3ce): first [toggle] discovers a provider
 * (`GET /providers`, first entry supporting `standard`; memoized) and starts
 * the recorder; the second stops it and posts the audio to
 * `POST /api/voice/transcription`, emitting [DictationEvent.Transcribed]
 * with the hub's text. [cancel] abandons the take without uploading.
 *
 * Web reference: `useDictation.ts` (standard mode; the realtime path is out
 * of scope for v1). No language override yet — the hub auto-detects; a
 * settings-backed `language` field is the M5 hook.
 *
 * Plain constructor over two seams — JVM tests drive it with fakes.
 */
class DictationController(
    private val api: DictationApi,
    private val recorder: DictationRecorder,
    private val scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<DictationEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<DictationEvent> = _events.asSharedFlow()

    /** First successful discovery wins for the session (web keeps a provider setting; v1 has none). */
    private var cachedProviderId: String? = null

    private var job: Job? = null

    /** Mic button press: Idle → record, Recording → stop + transcribe. */
    fun toggle() {
        when (_state.value) {
            DictationState.Idle -> startRecording()
            is DictationState.Recording -> stopAndTranscribe()
            // Starting/Transcribing: an operation is already in flight.
            DictationState.Starting, DictationState.Transcribing -> Unit
        }
    }

    /** Recording chip ✕: discard the take (no upload). */
    fun cancel() {
        if (_state.value !is DictationState.Recording) return
        runCatching { recorder.cancel() }
        _state.value = DictationState.Idle
    }

    private fun startRecording() {
        if (job?.isActive == true) return
        _state.value = DictationState.Starting
        job = scope.launch {
            val provider = cachedProviderId ?: discoverProvider() ?: run {
                _state.value = DictationState.Idle
                return@launch
            }
            cachedProviderId = provider
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
    }

    /** @return the chosen provider id, or null after emitting the failure event. */
    private suspend fun discoverProvider(): String? {
        val providers = try {
            api.transcriptionProviders().providers
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            _events.tryEmit(DictationEvent.Error(DictationErrorKind.HubUnreachable, error.message))
            return null
        }
        // First provider supporting standard (uploaded-file) transcription —
        // the hub lists them in its own preference order. `browser-local`
        // (realtime-only) never qualifies.
        val chosen = providers.firstOrNull { it.modes.contains("standard") }
        if (chosen == null) {
            _events.tryEmit(DictationEvent.NoProvider)
        }
        return chosen?.id
    }

    private fun stopAndTranscribe() {
        val provider = cachedProviderId ?: return // unreachable: set before Recording
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

package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.data.api.HapiApi
import app.hapi.protocol.chat.SessionExportArtifact
import app.hapi.protocol.chat.SessionExportArtifactResult
import app.hapi.protocol.chat.SessionExportFormat
import app.hapi.protocol.chat.buildSessionExportArtifact
import app.hapi.protocol.wire.SESSION_EXPORT_TOO_LARGE_CODE
import app.hapi.protocol.wire.SessionExportResponse
import app.hapi.protocol.wire.SessionExportTooLarge
import app.hapi.protocol.wire.SessionExportWarning
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the built artifact goes once ready. */
enum class SessionExportOutlet { SAVE, SHARE }

/** Transport seam over `HapiApi.getSessionExport` (tests fake this). */
fun interface SessionExportFetcher {
    suspend fun fetch(sessionId: String, force: Boolean): SessionExportResponse
}

class ApiSessionExportFetcher(private val api: HapiApi) : SessionExportFetcher {
    override suspend fun fetch(sessionId: String, force: Boolean): SessionExportResponse =
        api.getSessionExport(sessionId, force)
}

/** Everything the dialog needs from the active hub + app graph. */
class SessionExportSupport(
    val fetcher: SessionExportFetcher,
    val formatStore: SessionExportFormatStore,
)

sealed class SessionExportFailure {
    /** Save/share write failed after a successful fetch. */
    data object Write : SessionExportFailure()

    /** Fetch or decode failure that is not the too-large cap. */
    data class Transport(val error: Throwable) : SessionExportFailure()
}

/**
 * The dialog's state machine — a port of `SessionExportDialog.tsx`'s
 * `handleDownload`: persist the format on the action click, fetch
 * (force=true once the over-limit warning is showing), map the warning /
 * too-large / failure outcomes, and hand a ready artifact back for the
 * outlet. Artifact assembly runs off the main dispatcher; the in-flight
 * request dies with the caller's scope when the dialog leaves composition
 * (the web twin aborts on close).
 */
class SessionExportController(
    private val sessionId: String,
    private val fetcher: SessionExportFetcher,
    private val formatStore: SessionExportFormatStore,
    private val scope: CoroutineScope,
    /** Where artifact text is built; tests swap in a deterministic dispatcher. */
    private val artifactDispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    private val mutableState = MutableStateFlow<SessionExportUiState>(SessionExportUiState.Idle)
    val state: StateFlow<SessionExportUiState> = mutableState.asStateFlow()

    private val mutableFormat = MutableStateFlow(SessionExportFormat.JSON)
    val format: StateFlow<SessionExportFormat> = mutableFormat.asStateFlow()

    private var requestJob: Job? = null

    init {
        // `readSessionExportFormat()` on open — races the first click exactly
        // like the web twin.
        scope.launch { mutableFormat.value = formatStore.read() }
    }

    fun setFormat(format: SessionExportFormat) {
        mutableFormat.value = format
    }

    fun requestExport(outlet: SessionExportOutlet) {
        if (mutableState.value is SessionExportUiState.Exporting) return
        val format = mutableFormat.value
        val force = mutableState.value is SessionExportUiState.Warned
        requestJob?.cancel()
        requestJob = scope.launch {
            mutableState.value = SessionExportUiState.Exporting(outlet)
            try {
                formatStore.write(format)
                when (val response = fetcher.fetch(sessionId, force)) {
                    is SessionExportResponse.Warning ->
                        mutableState.value = SessionExportUiState.Warned(response.warning, outlet)
                    is SessionExportResponse.Full -> {
                        val artifact = withContext(artifactDispatcher) {
                            buildSessionExportArtifact(response.export, response.raw, format)
                        }
                        mutableState.value = when (artifact) {
                            is SessionExportArtifactResult.TooLarge -> SessionExportUiState.TooLarge(
                                count = artifact.count,
                                estimatedBytes = artifact.estimatedBytes,
                                maxBytes = artifact.maxBytes,
                            )
                            is SessionExportArtifactResult.Ready ->
                                SessionExportUiState.Ready(artifact.artifact, outlet)
                        }
                    }
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (error: Exception) {
                val tooLarge = (error as? ApiError)
                    ?.takeIf { it.code == SESSION_EXPORT_TOO_LARGE_CODE }
                    ?.let { SessionExportTooLarge.fromBody(it.body) }
                mutableState.value = if (tooLarge != null) {
                    SessionExportUiState.TooLarge(
                        count = tooLarge.count,
                        estimatedBytes = tooLarge.estimatedBytes,
                        maxBytes = tooLarge.maxBytes,
                    )
                } else {
                    SessionExportUiState.Failed(SessionExportFailure.Transport(error))
                }
            }
        }
    }

    /** The outlet's write step failed (SAF stream / cache file). */
    fun writeFailed() {
        mutableState.value = SessionExportUiState.Failed(SessionExportFailure.Write)
    }

    /** Back to Idle after the system flow finished or was cancelled. */
    fun reset() {
        mutableState.value = SessionExportUiState.Idle
    }
}

/** Dialog states; [SessionExportUiState.Ready] triggers the outlet immediately. */
sealed class SessionExportUiState {
    data object Idle : SessionExportUiState()
    data class Exporting(val outlet: SessionExportOutlet) : SessionExportUiState()
    data class Warned(val warning: SessionExportWarning, val outlet: SessionExportOutlet) : SessionExportUiState()
    data class TooLarge(val count: Int, val estimatedBytes: Long, val maxBytes: Long) : SessionExportUiState()
    data class Failed(val failure: SessionExportFailure) : SessionExportUiState()
    data class Ready(val artifact: SessionExportArtifact, val outlet: SessionExportOutlet) : SessionExportUiState()
}

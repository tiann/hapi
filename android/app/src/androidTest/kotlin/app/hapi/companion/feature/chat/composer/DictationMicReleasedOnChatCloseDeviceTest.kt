package app.hapi.companion.feature.chat.composer

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.TranscriptionProviderInfo
import app.hapi.protocol.wire.TranscriptionProvidersResponse
import app.hapi.protocol.wire.TranscriptionResponse
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

// ------------------------------------------------------------------ seams --

/** One realtime-capable deepgram provider; `transcribe` must never run. */
private class ScriptedDictationApi : DictationApi {
    override suspend fun transcriptionProviders() = TranscriptionProvidersResponse(
        providers = listOf(
            TranscriptionProviderInfo(id = "deepgram", label = "Deepgram", modes = listOf("realtime", "standard")),
        ),
    )

    override suspend fun transcribe(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?,
    ): TranscriptionResponse = error("standard (upload) dictation must not run in this test")
}

/** The realtime provider is chosen, so the recorder seam must never be touched. */
private object ForbiddenRecorder : DictationRecorder {
    override val filename: String = ""
    override val mimeType: String = ""
    override fun start() = error("standard dictation must not start")
    override fun stop(): ByteArray? = error("standard dictation must not stop")
    override fun cancel() = error("standard dictation must not cancel")
}

/**
 * Client half of the provider websocket. The socket lifecycle itself is
 * pinned on the JVM against the production OkHttp adapter
 * (DeepgramRealtimeLoopbackTest); on the device the scripted factory hands
 * the REAL session logic a socket that opens off-thread like a network
 * handshake would — no network needed on the emulator.
 */
private class ScriptedSocket(private val listener: ProviderSocketListener) : ProviderSocket {
    @Volatile var open = false
    val textSends = CopyOnWriteArrayList<String>()
    val closeCalls = AtomicInteger(0)

    override val isOpen: Boolean get() = open
    override fun send(text: String) {
        textSends += text
    }

    override fun send(bytes: ByteArray) = Unit

    override fun close() {
        closeCalls.incrementAndGet()
        open = false
    }

    fun fireOpen() {
        open = true
        listener.onOpen()
    }

    fun fireMessage(json: String) = listener.onMessage(json)
}

private class ScriptedSocketFactory : ProviderSocketFactory {
    val sockets = CopyOnWriteArrayList<ScriptedSocket>()
    val urls = CopyOnWriteArrayList<String>()
    val tokens = CopyOnWriteArrayList<String>()

    override fun open(url: String, bearerToken: String, listener: ProviderSocketListener): ProviderSocket {
        val socket = ScriptedSocket(listener)
        sockets += socket
        urls += url
        tokens += bearerToken
        // A real handshake completes off the caller's stack.
        Thread({ Thread.sleep(50); socket.fireOpen() }, "scripted-dictation-open").start()
        return socket
    }
}

/**
 * The screen wiring injects [AudioRecordStreamingSource] here in production
 * (`ChatViewModelHolder`, Navigation.kt). CI emulators have no usable
 * microphone, so the device test stubs the seam — no [android.media.AudioRecord]
 * is ever constructed on this path — while mirroring the production
 * stop/release semantics (`release()` stops an active capture first).
 */
private class StubStreamingAudioSource : StreamingAudioSource {
    val starts = AtomicInteger(0)
    val stops = AtomicInteger(0)
    val releases = AtomicInteger(0)

    @Volatile var capturing = false

    override fun startCapture(onChunk: (ByteArray) -> Unit) {
        starts.incrementAndGet()
        capturing = true
    }

    override fun stopCapture() {
        stops.incrementAndGet()
        capturing = false
    }

    override fun release() {
        if (capturing) stopCapture()
        releases.incrementAndGet()
    }
}

/** The REAL streaming session logic over the two stubbed hardware seams. */
private class RealSessionEngine(
    private val sockets: ProviderSocketFactory,
    private val audio: StreamingAudioSource,
) : RealtimeDictationEngine {
    override val supportedProviders: Set<String> = setOf("deepgram")

    override suspend fun start(
        provider: String,
        language: String?,
        callbacks: RealtimeTranscriptionCallbacks,
    ): RealtimeTranscriptionSession =
        DeepgramRealtimeDictation(sockets, audio).start(
            getToken = { "device-token" },
            language = language,
            callbacks = callbacks,
        )
}

/**
 * Disposal mirror of the production `ChatViewModelHolder` (Navigation.kt):
 * the controller lives in a holder ViewModel so a recording survives
 * rotation, and `onCleared` — which runs when the chat destination leaves
 * the back stack for good — cancels the dictation and its scope. The test
 * hosts the shell in a real [ViewModelStore] and closes the chat by
 * clearing it, the same mechanism NavController uses on back navigation.
 */
private class ChatShell(
    api: DictationApi,
    sockets: ProviderSocketFactory,
    audio: StreamingAudioSource,
) : ViewModel() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val dictation = DictationController(
        api = api,
        recorder = ForbiddenRecorder,
        scope = scope,
        realtimeEngine = RealSessionEngine(sockets, audio),
    )

    override fun onCleared() {
        dictation.cancel()
        scope.cancel()
    }
}

// ------------------------------------------------------------------ test --

/**
 * Maintainer review (PR #2182): "... plus device confirmation that
 * recording stops when chat closes." CI emulators have no usable
 * microphone, so the audio-source seam is stubbed at exactly the point the
 * production holder injects `AudioRecordStreamingSource` — the mic button,
 * the dictation state machine, and the streaming session logic (connect →
 * capture → interim preview) are all real, driven through the real
 * composer UI.
 */
class DictationMicReleasedOnChatCloseDeviceTest {
    @get:Rule val compose = createComposeRule()

    private val api = ScriptedDictationApi()
    private val sockets = ScriptedSocketFactory()
    private val audio = StubStreamingAudioSource()

    @Test fun recordingStopsTheStreamingSourceIsReleasedAndNoFlagRemainsWhenTheChatCloses() {
        val store = ViewModelStore()
        val shell = ViewModelProvider(store, object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ChatShell(api, sockets, audio) as T
        })[ChatShell::class.java]

        compose.setContent {
            HapiTheme {
                // Same wiring ChatScreen applies: availability gate hides the
                // mic until a provider is confirmed, toggle routes to the
                // controller (the RECORD_AUDIO gate sits upstream in
                // ChatScreen and is stubbed away with the audio seam here).
                val dictationState = shell.dictation.state.collectAsState().value
                val available = shell.dictation.isAvailable.collectAsState().value
                LaunchedEffect(shell.dictation) { shell.dictation.refreshAvailability() }
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = false),
                    onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = if (available) dictationState else null,
                    onDictationToggle = { shell.dictation.toggle() },
                    onDictationCancel = { shell.dictation.cancel() },
                )
            }
        }

        // Provider discovered → the mic affordance appears.
        compose.waitUntil(10_000) { shell.dictation.isAvailable.value }
        compose.onNodeWithContentDescription("Start dictation").assertIsDisplayed()

        // Open dictation through the real mic button: the production listen
        // URL is requested and the streaming source starts capturing.
        compose.onNodeWithContentDescription("Start dictation").performClick()
        compose.waitUntil(10_000) { audio.capturing }
        val listenUrl = sockets.urls.single()
        assertTrue("expected the production listen URL, got $listenUrl", listenUrl.startsWith("wss://api.deepgram.com/v1/listen?model=nova-3"))
        assertEquals("device-token", sockets.tokens.single())

        // The take goes live end to end: interim preview renders, mic shows
        // the stop affordance, capture flag up.
        val socket = sockets.sockets.single()
        compose.runOnIdle {
            socket.fireMessage(
                """{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"device live preview"}]}}""",
            )
        }
        compose.onNodeWithText("device live preview").assertIsDisplayed()
        compose.onNodeWithContentDescription("Stop recording").assertIsDisplayed()
        assertTrue(audio.capturing)

        // Close the chat: the destination is popped, the holder ViewModel is
        // cleared, and its onCleared cancels the dictation (production path).
        compose.runOnIdle { store.clear() }

        // The streaming source was stopped and released (exactly once —
        // no second take), the session was abandoned on the socket, and no
        // recording flag remains in the UI or the controller.
        compose.waitUntil(10_000) { audio.releases.get() > 0 }
        assertFalse(audio.capturing)
        assertEquals(1, audio.starts.get())
        assertTrue(audio.stops.get() >= 1)
        assertEquals(1, audio.releases.get())
        assertEquals(listOf("""{"type":"CloseStream"}"""), socket.textSends)
        assertEquals(1, socket.closeCalls.get())
        compose.waitUntil(10_000) { shell.dictation.state.value == DictationState.Idle }
        compose.onNodeWithText("device live preview").assertDoesNotExist()
        compose.onNodeWithContentDescription("Start dictation").assertIsDisplayed()
    }
}

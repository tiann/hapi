package app.hapi.companion.feature.chat.composer

import app.hapi.protocol.wire.TranscriptionProviderInfo
import app.hapi.protocol.wire.TranscriptionProvidersResponse
import app.hapi.protocol.wire.TranscriptionResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest

// ------------------------------------------------------------------ fakes --

private class FakeDictationApi : DictationApi {
    var providersResult: TranscriptionProvidersResponse = TranscriptionProvidersResponse(
        providers = listOf(
            TranscriptionProviderInfo(id = "openai", label = "OpenAI", modes = listOf("standard", "realtime")),
            TranscriptionProviderInfo(id = "groq", label = "Groq", modes = listOf("standard")),
        ),
    )
    var providersFailure: Exception? = null
    var providersCalls = 0

    var transcribeResult: TranscriptionResponse = TranscriptionResponse(text = "hello world")
    var transcribeFailure: Exception? = null
    val transcribeCalls = mutableListOf<TranscribeCall>()

    class TranscribeCall(
        val audio: ByteArray,
        val filename: String,
        val mimeType: String,
        val provider: String,
        val language: String?,
    )

    override suspend fun transcriptionProviders(): TranscriptionProvidersResponse {
        providersCalls += 1
        providersFailure?.let { throw it }
        return providersResult
    }

    override suspend fun transcribe(
        audio: ByteArray,
        filename: String,
        mimeType: String,
        provider: String,
        language: String?,
    ): TranscriptionResponse {
        transcribeCalls += TranscribeCall(audio, filename, mimeType, provider, language)
        transcribeFailure?.let { throw it }
        return transcribeResult
    }
}

private class FakeRecorder : DictationRecorder {
    override val filename = "speech.m4a"
    override val mimeType = "audio/mp4"

    var startFailure: Exception? = null
    var stopResult: ByteArray? = byteArrayOf(1, 2, 3)
    var startCalls = 0
    var stopCalls = 0
    var cancelCalls = 0

    override fun start() {
        startCalls += 1
        startFailure?.let { throw it }
    }

    override fun stop(): ByteArray? {
        stopCalls += 1
        return stopResult
    }

    override fun cancel() {
        cancelCalls += 1
    }
}

private class Harness(testScope: kotlinx.coroutines.test.TestScope) {
    val api = FakeDictationApi()
    val recorder = FakeRecorder()
    val events = mutableListOf<DictationEvent>()
    val controller = DictationController(
        api = api,
        recorder = recorder,
        scope = testScope.backgroundScope,
        now = { 42_000L },
    )

    init {
        testScope.backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            controller.events.collect { events += it }
        }
    }
}

// ------------------------------------------------------------------ tests --

class DictationControllerTest {

    @Test
    fun `record then stop uploads the take and emits the transcript`() = runTest {
        val harness = Harness(this)

        harness.controller.toggle()
        val recording = harness.controller.state.first { it is DictationState.Recording }
        assertEquals(42_000L, (recording as DictationState.Recording).startedAtMs)
        assertEquals(1, harness.recorder.startCalls)

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        val call = harness.api.transcribeCalls.single()
        assertTrue(call.audio.contentEquals(byteArrayOf(1, 2, 3)))
        assertEquals("speech.m4a", call.filename)
        assertEquals("audio/mp4", call.mimeType)
        // First provider supporting standard mode wins.
        assertEquals("openai", call.provider)
        assertNull(call.language)
        assertEquals(listOf<DictationEvent>(DictationEvent.Transcribed("hello world")), harness.events)
    }

    @Test
    fun `provider discovery is memoized across takes`() = runTest {
        val harness = Harness(this)

        repeat(2) {
            harness.controller.toggle()
            harness.controller.state.first { it is DictationState.Recording }
            harness.controller.toggle()
            harness.controller.state.first { it is DictationState.Idle }
        }

        assertEquals(1, harness.api.providersCalls)
        assertEquals(2, harness.api.transcribeCalls.size)
    }

    @Test
    fun `no standard-capable provider emits NoProvider and never records`() = runTest {
        val harness = Harness(this)
        harness.api.providersResult = TranscriptionProvidersResponse(
            // Realtime-only (browser-local shape) must not qualify.
            providers = listOf(
                TranscriptionProviderInfo(id = "browser-local", label = "Browser", modes = listOf("realtime")),
            ),
        )

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        assertEquals(listOf<DictationEvent>(DictationEvent.NoProvider), harness.events)
        assertEquals(0, harness.recorder.startCalls)
    }

    @Test
    fun `provider discovery failure surfaces as an error`() = runTest {
        val harness = Harness(this)
        harness.api.providersFailure = RuntimeException("hub unreachable")

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        assertEquals(
            listOf<DictationEvent>(
                DictationEvent.Error(DictationErrorKind.HubUnreachable, "hub unreachable"),
            ),
            harness.events,
        )
        assertEquals(0, harness.recorder.startCalls)
    }

    @Test
    fun `recorder start failure surfaces as an error`() = runTest {
        val harness = Harness(this)
        harness.recorder.startFailure = RuntimeException("mic busy")

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        assertEquals(
            listOf<DictationEvent>(DictationEvent.Error(DictationErrorKind.StartFailed, "mic busy")),
            harness.events,
        )
        assertTrue(harness.api.transcribeCalls.isEmpty())
    }

    @Test
    fun `empty take reports no audio without uploading`() = runTest {
        val harness = Harness(this)
        harness.recorder.stopResult = null

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Recording }
        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        assertEquals(
            listOf<DictationEvent>(DictationEvent.Error(DictationErrorKind.NoAudio)),
            harness.events,
        )
        assertTrue(harness.api.transcribeCalls.isEmpty())
    }

    @Test
    fun `transcription failure emits the error and returns to idle`() = runTest {
        val harness = Harness(this)
        harness.api.transcribeFailure = RuntimeException("upload exploded")

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Recording }
        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Idle }

        assertEquals(
            listOf<DictationEvent>(
                DictationEvent.Error(DictationErrorKind.TranscriptionFailed, "upload exploded"),
            ),
            harness.events,
        )
    }

    @Test
    fun `cancel discards the take without uploading`() = runTest {
        val harness = Harness(this)

        harness.controller.toggle()
        harness.controller.state.first { it is DictationState.Recording }
        harness.controller.cancel()

        assertIs<DictationState.Idle>(harness.controller.state.value)
        assertEquals(1, harness.recorder.cancelCalls)
        assertEquals(0, harness.recorder.stopCalls)
        assertTrue(harness.api.transcribeCalls.isEmpty())
        assertTrue(harness.events.isEmpty())
    }
}

class AppendTranscriptTest {

    @Test
    fun `appends with a single space separator`() {
        assertEquals("draft text new words", appendTranscript("draft text", "new words"))
    }

    @Test
    fun `does not double separators after trailing whitespace`() {
        assertEquals("draft ok", appendTranscript("draft ", "ok"))
        assertEquals("line\nok", appendTranscript("line\n", "ok"))
    }

    @Test
    fun `empty composer takes the trimmed transcript verbatim`() {
        assertEquals("hello", appendTranscript("", "  hello  "))
    }

    @Test
    fun `blank transcript leaves the text untouched`() {
        assertEquals("draft", appendTranscript("draft", "   "))
    }
}

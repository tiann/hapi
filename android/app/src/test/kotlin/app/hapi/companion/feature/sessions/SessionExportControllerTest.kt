package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.protocol.chat.SessionExportFormat
import app.hapi.protocol.wire.SessionExportResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest

/**
 * [SessionExportController] — the dialog's state machine against the web
 * twin's `handleDownload`: format persistence on click, force=true after the
 * over-limit warning, the 413 coded-error mapping, and terminal-state
 * transitions. The fetcher/store seams are faked; artifact assembly is the
 * real builder (its byte-parity has its own fixture tests).
 */
class SessionExportControllerTest {

    private class FakeFetcher(
        private val respond: suspend (force: Boolean) -> SessionExportResponse,
    ) : SessionExportFetcher {
        val calls = mutableListOf<Pair<String, Boolean>>()

        override suspend fun fetch(sessionId: String, force: Boolean): SessionExportResponse {
            calls += sessionId to force
            return respond(force)
        }
    }

    private class FakeStore(initial: String? = null) : SessionExportFormatStore {
        var stored: String? = initial
        val writes = mutableListOf<SessionExportFormat>()

        override suspend fun read(): SessionExportFormat = SessionExportFormat.fromStorageValue(stored)

        override suspend fun write(format: SessionExportFormat) {
            writes += format
        }
    }

    private fun fullResponse(): SessionExportResponse = SessionExportResponse.parse(
        """
            {
              "schemaVersion": 2,
              "exportedAt": 1700000000123,
              "session": {
                "id": "abcdefgh1234", "namespace": "test", "seq": 1,
                "createdAt": 1700000000000, "updatedAt": 1700000000000, "active": false,
                "metadataVersion": 1, "agentStateVersion": 1,
                "thinking": false, "thinkingAt": 0,
                "metadata": { "path": "/home/u/proj", "host": "mac", "name": "Fixture Sweep" }
              },
              "messages": [
                { "id": "m1", "createdAt": 1700000000000, "content": { "role": "user", "content": { "type": "text", "text": "hi" } } }
              ],
              "scratchlist": []
            }
        """.trimIndent(),
    )

    private fun controller(
        fetcher: SessionExportFetcher,
        store: SessionExportFormatStore,
        scope: CoroutineScope,
        artifactDispatcher: CoroutineDispatcher,
    ) = SessionExportController("sess-1", fetcher, store, scope, artifactDispatcher)

    /** Unconfined scope + artifact dispatcher: every step runs to completion synchronously. */
    private fun eagerDispatcher() = UnconfinedTestDispatcher()

    @Test
    fun `save flow reads the stored format persists the click choice and reaches Ready`() = runTest {
        val store = FakeStore(initial = "markdown")
        val fetcher = FakeFetcher { _ -> fullResponse() }
        val controller = controller(fetcher, store, CoroutineScope(eagerDispatcher()), eagerDispatcher())

        // init read ran eagerly: the stored markdown choice is the opening format.
        assertEquals(SessionExportFormat.MARKDOWN, controller.format.value)

        controller.setFormat(SessionExportFormat.JSON)
        controller.requestExport(SessionExportOutlet.SAVE)

        assertEquals(listOf("sess-1" to false), fetcher.calls)
        assertEquals(listOf(SessionExportFormat.JSON), store.writes)

        val ready = assertIs<SessionExportUiState.Ready>(controller.state.value)
        assertEquals(SessionExportOutlet.SAVE, ready.outlet)
        assertEquals(1, ready.artifact.messageCount)
        assertEquals("fixture-sweep-abcdefgh-2023-11-14.json", ready.artifact.filename)
    }

    @Test
    fun `share outlet is carried through to the artifact`() = runTest {
        val store = FakeStore(initial = "markdown")
        val fetcher = FakeFetcher { _ -> fullResponse() }
        val controller = controller(fetcher, store, CoroutineScope(eagerDispatcher()), eagerDispatcher())

        controller.requestExport(SessionExportOutlet.SHARE)

        val ready = assertIs<SessionExportUiState.Ready>(controller.state.value)
        assertEquals(SessionExportOutlet.SHARE, ready.outlet)
        // The persisted format is the one in effect at click time.
        assertEquals(listOf(SessionExportFormat.MARKDOWN), store.writes)
        assertEquals(SessionExportFormat.MARKDOWN, ready.artifact.format)
        assertEquals("fixture-sweep-abcdefgh-2023-11-14.md", ready.artifact.filename)
    }

    @Test
    fun `warning keeps the dialog open and the confirmed retry sends force=true`() = runTest {
        val store = FakeStore()
        val fetcher = FakeFetcher { force ->
            if (force) fullResponse() else SessionExportResponse.parse(
                """{"type":"warning","count":25000,"limit":20000,"estimatedBytes":9876543}""",
            )
        }
        val controller = controller(fetcher, store, CoroutineScope(eagerDispatcher()), eagerDispatcher())

        controller.requestExport(SessionExportOutlet.SAVE)
        val warned = assertIs<SessionExportUiState.Warned>(controller.state.value)
        assertEquals(25_000, warned.warning.count)
        assertEquals(20_000, warned.warning.limit)
        assertEquals(9_876_543L, warned.warning.estimatedBytes)
        assertEquals(SessionExportOutlet.SAVE, warned.outlet)

        controller.requestExport(SessionExportOutlet.SAVE)
        assertEquals(listOf("sess-1" to false, "sess-1" to true), fetcher.calls)
        assertIs<SessionExportUiState.Ready>(controller.state.value)
    }

    @Test
    fun `413 coded ApiError surfaces as TooLarge with parsed body details`() = runTest {
        val store = FakeStore()
        val fetcher = FakeFetcher { _ ->
            throw ApiError(
                status = 413,
                code = "session_export_too_large",
                body = """{"type":"too-large","error":"Session export too large","code":"session_export_too_large","count":30000,"estimatedBytes":123456789,"maxBytes":104857600}""",
            )
        }
        val controller = controller(fetcher, store, CoroutineScope(eagerDispatcher()), eagerDispatcher())

        controller.requestExport(SessionExportOutlet.SAVE)

        val tooLarge = assertIs<SessionExportUiState.TooLarge>(controller.state.value)
        assertEquals(30_000, tooLarge.count)
        assertEquals(123_456_789L, tooLarge.estimatedBytes)
        assertEquals(104_857_600L, tooLarge.maxBytes)
    }

    @Test
    fun `uncoded failures land in Failed transport`() = runTest {
        val store = FakeStore()
        val fetcher = FakeFetcher { _ -> throw ApiError(status = 500, body = "boom") }
        val controller = controller(fetcher, store, CoroutineScope(eagerDispatcher()), eagerDispatcher())

        controller.requestExport(SessionExportOutlet.SAVE)
        val failed = assertIs<SessionExportUiState.Failed>(controller.state.value)
        assertIs<SessionExportFailure.Transport>(failed.failure)

        // The write outlet's failure is distinct, and reset returns to Idle.
        controller.writeFailed()
        assertIs<SessionExportUiState.Failed>(controller.state.value).let { state ->
            assertIs<SessionExportFailure.Write>(state.failure)
        }
        controller.reset()
        assertIs<SessionExportUiState.Idle>(controller.state.value)
    }
}

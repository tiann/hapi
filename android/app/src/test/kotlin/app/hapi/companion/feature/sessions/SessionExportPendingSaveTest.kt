package app.hapi.companion.feature.sessions

import app.hapi.protocol.chat.SessionExportArtifact
import app.hapi.protocol.chat.SessionExportFormat
import app.hapi.protocol.wire.SessionExportResponse
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest

/**
 * [SessionExportPendingSave] — the review r4367883584 regression pair. The
 * system SAF picker can rotate or kill the activity behind it; the armed save
 * must survive that recreation (through the [SessionExportPendingSaveSaver]
 * round trip, exactly as `rememberSaveable` performs it) so the picker result
 * writes the staged artifact instead of silently nothing.
 */
class SessionExportPendingSaveTest {

    private val artifactText = """
        {"schemaVersion":2,"exportedAt":1700000000123,"session":{"id":"abcdefgh1234"},
        "messages":[{"id":"m1","content":{"role":"user","content":{"type":"text","text":"export me"}}}]}
    """.trimIndent()

    private fun artifact() = SessionExportArtifact(
        filename = "fixture-sweep-abcdefgh-2023-11-14.json",
        format = SessionExportFormat.JSON,
        text = artifactText,
        messageCount = 1,
        byteCount = artifactText.toByteArray(Charsets.UTF_8).size.toLong(),
    )

    /** The eager dispatcher keeps the staging/copies inline in runTest time. */
    private fun eager() = UnconfinedTestDispatcher()

    @Test
    fun `picker result after recreation writes the staged artifact not an empty document`() = runTest {
        val cacheDir = File(System.getProperty("java.io.tmpdir"), "hapi-export-pending-${System.nanoTime()}")
        val document = ByteArrayOutputStream()
        val sink = SessionExportDocumentSink { uri ->
            assertEquals("content://picked/fixture", uri)
            document
        }
        try {
            // Save armed while the picker opens…
            val armed = SessionExportPendingSave.arm(artifact(), cacheDir, eager())
            assertTrue(armed.byteCount > 0, "staging wrote no bytes")
            assertTrue(File(armed.path).isFile)

            // …then the picker rotates/kills us: recreation serializes the
            // record through the rememberSaveable payload and rebuilds every
            // remember{} holder (the controller included) from scratch. The
            // saver's save side is a one-line delegation to
            // pendingSessionExportToSavedState (SaverScope member-extension
            // save() is not invocable from this Kotlin against compose 1.8
            // metadata); the restore side runs through the real saver object.
            val saved = pendingSessionExportToSavedState(armed)
            val restored = SessionExportPendingSaveSaver.restore(saved!!)
            assertEquals(armed.path, restored!!.path)
            assertEquals(armed.filename, restored.filename)
            assertEquals(armed.byteCount, restored.byteCount)

            // The picker result now lands on the restored record.
            assertIs<SessionExportSaveOutcome.Saved>(
                restored.complete("content://picked/fixture", sink, eager()),
            )
            assertEquals(artifactText, document.toString(Charsets.UTF_8.name()))
            assertFalse(document.toByteArray().isEmpty(), "document written empty")
            assertFalse(File(restored.path).exists(), "staged cache file must be consumed")
        } finally {
            cacheDir.deleteRecursively()
        }
    }

    @Test
    fun `recreation empties the controller state that the old save path read`() = runTest {
        // Documents the gap the pending save closes: the pre-persistence
        // launcher callback sourced the artifact from controller.state, and a
        // recreated controller (remember{} rebuilt) is Idle — the completed
        // picker would have found no artifact and written nothing.
        val fetcher = SessionExportFetcher { _, _ -> fullResponse() }
        val store = object : SessionExportFormatStore {
            override suspend fun read(): SessionExportFormat = SessionExportFormat.JSON
            override suspend fun write(format: SessionExportFormat) = Unit
        }
        val dispatcher = eager()
        val before = SessionExportController("sess-1", fetcher, store, CoroutineScope(dispatcher), dispatcher, dispatcher)
        before.requestExport(SessionExportOutlet.SAVE)
        assertIs<SessionExportUiState.Ready>(before.state.value)

        val after = SessionExportController("sess-1", fetcher, store, CoroutineScope(dispatcher), dispatcher, dispatcher)
        assertIs<SessionExportUiState.Idle>(after.state.value)
        assertNull((after.state.value as? SessionExportUiState.Ready)?.artifact)
    }

    @Test
    fun `cancelled or unstaged result never opens the document`() = runTest {
        val cacheDir = File(System.getProperty("java.io.tmpdir"), "hapi-export-pending-${System.nanoTime()}")
        var opened = 0
        val sink = SessionExportDocumentSink { uri ->
            opened += 1
            ByteArrayOutputStream()
        }
        try {
            // Cancelled picker: the staged file is discarded, no stream opens.
            val armed = SessionExportPendingSave.arm(artifact(), cacheDir, eager())
            armed.discard(eager())
            assertFalse(File(armed.path).exists())
            assertIs<SessionExportSaveOutcome.Failed>(
                armed.complete("content://picked/fixture", sink, eager()),
            )
            assertEquals(0, opened, "a vanished stage must not create an empty document")

            // Empty save list (nothing armed) restores to null.
            assertNull(pendingSessionExportFromSavedState(emptyList()))
            assertNull(SessionExportPendingSaveSaver.restore(emptyList<String>()))
        } finally {
            cacheDir.deleteRecursively()
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
}

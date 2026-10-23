package app.hapi.companion.feature.scratchlist

import app.hapi.data.store.ScratchlistAttachmentDeleteResult
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.ScratchlistEntryOps
import app.hapi.data.store.ScratchlistMoveDirection
import app.hapi.data.store.ScratchlistSessionState
import app.hapi.data.store.ScratchlistUploadResult
import app.hapi.data.store.SessionScratchlist
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import app.hapi.protocol.wire.ScratchlistEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * Minimal recording [SessionScratchlist] — the store seam is fully faked
 * (no MockWebServer in :app); [ScratchlistEntryOps.moveEntry] is reused so
 * the fake reorders exactly like production.
 */
private class RecordingScratchlist(entries: List<ScratchlistEntry>) : SessionScratchlist {
    val moves = mutableListOf<Triple<String, String, ScratchlistMoveDirection>>()
    val sessionState = MutableStateFlow(ScratchlistSessionState(entries = entries, loaded = true))

    override fun state(sessionId: String): Flow<ScratchlistSessionState> = sessionState
    override fun currentState(sessionId: String): ScratchlistSessionState = sessionState.value
    override fun open(sessionId: String) = Unit
    override fun release(sessionId: String) = Unit
    override suspend fun refresh(sessionId: String) = Unit
    override suspend fun createEntry(
        sessionId: String,
        text: String,
        attachments: List<ScratchlistAttachment>,
    ): ScratchlistCreateResult = ScratchlistCreateResult.Failed(IllegalStateException("unused"))
    override suspend fun updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: List<ScratchlistAttachment>?,
    ): Boolean = true
    override suspend fun deleteEntry(sessionId: String, entryId: String): Boolean = true
    override fun moveEntry(sessionId: String, entryId: String, direction: ScratchlistMoveDirection) {
        moves += Triple(sessionId, entryId, direction)
        sessionState.value = sessionState.value.copy(
            entries = ScratchlistEntryOps.moveEntry(sessionState.value.entries, entryId, direction)
        )
    }
    override suspend fun uploadAttachment(
        sessionId: String,
        filename: String,
        bytes: ByteArray,
        mimeType: String,
    ): ScratchlistUploadResult = ScratchlistUploadResult.Failed("unused")
    override suspend fun deleteAttachment(
        sessionId: String,
        attachmentId: String,
    ): ScratchlistAttachmentDeleteResult = ScratchlistAttachmentDeleteResult.Removed
    override suspend fun limits(sessionId: String) = ScratchlistAttachmentLimits.DEFAULT
}

class ScratchlistViewModelTest {

    private fun entry(id: String, text: String = "note") = ScratchlistEntry(
        entryId = id,
        text = text,
        createdAt = 1,
        updatedAt = 1,
    )

    private fun TestScope.viewModelWith(store: RecordingScratchlist): ScratchlistViewModel =
        ScratchlistViewModel(sessionId = "s1", store = store, scope = backgroundScope)

    @Test
    fun `move entry hands the local-only reorder to the store and the ui state follows`() =
        runTest {
            val store = RecordingScratchlist(listOf(entry("e1", "one"), entry("e2", "two")))
            val viewModel = viewModelWith(store)
            viewModel.start()

            viewModel.moveEntry("e2", ScratchlistMoveDirection.UP)

            assertEquals(listOf(Triple("s1", "e2", ScratchlistMoveDirection.UP)), store.moves)
            assertEquals(
                listOf("e2", "e1"),
                viewModel.uiState.first { it.entries.map(ScratchlistEntry::entryId) == listOf("e2", "e1") }
                    .entries.map { it.entryId },
            )
        }

    @Test
    fun `move entry on the first row up is a store no-op`() = runTest {
        val store = RecordingScratchlist(listOf(entry("e1", "one"), entry("e2", "two")))
        val viewModel = viewModelWith(store)
        viewModel.start()

        viewModel.moveEntry("e1", ScratchlistMoveDirection.UP)

        assertEquals(listOf(Triple("s1", "e1", ScratchlistMoveDirection.UP)), store.moves)
        assertEquals(
            listOf("e1", "e2"),
            viewModel.uiState.first { it.entries.isNotEmpty() }.entries.map { it.entryId },
        )
    }

    @Test
    fun `delete entry closes an open editor for that entry`() = runTest {
        val store = RecordingScratchlist(listOf(entry("e1", "long enough")))
        val viewModel = viewModelWith(store)
        viewModel.start()
        advanceUntilIdle()

        viewModel.openEditor(store.currentState("s1").entries.single())
        assertTrue(viewModel.editor.value?.entryId == "e1")

        viewModel.deleteEntry("e1")
        advanceUntilIdle()

        assertEquals(null, viewModel.editor.value)
    }
}

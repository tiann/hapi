package app.hapi.companion.feature.scratchlist

import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.store.ScratchlistAttachmentDeleteResult
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.ScratchlistMoveDirection
import app.hapi.data.store.ScratchlistSessionState
import app.hapi.data.store.ScratchlistUploadResult
import app.hapi.data.store.SessionScratchlist
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import app.hapi.protocol.wire.ScratchlistEntry
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ScratchlistActionsTest {
    @get:Rule val compose = createComposeRule()

    private fun showEntry(text: String): ActionScratchlist {
        val store = ActionScratchlist(ScratchlistEntry("entry", text, createdAt = 1, updatedAt = 1))
        compose.setContent {
            val scope = rememberCoroutineScope()
            val viewModel = remember { ScratchlistViewModel("session", store, scope) }
            HapiTheme {
                ScratchlistScreen(viewModel, ScratchlistMedia(null) { null }, onBack = {})
            }
        }
        compose.onNodeWithText(text).assertIsDisplayed()
        return store
    }

    @Test fun copyingTheSameEntryRestartsTheFullFeedbackInterval() {
        showEntry("note")
        compose.mainClock.autoAdvance = false
        compose.onNodeWithContentDescription("Copy text to clipboard (not images)").performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithContentDescription("Copied!").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithContentDescription("Copied!").performClick()
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithContentDescription("Copied!").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithContentDescription("Copy text to clipboard (not images)").assertIsDisplayed()
    }

    @Test fun shorteningAnUnsavedLongEntryStillRequiresDeletionConfirmation() {
        val text = "x".repeat(101)
        val store = showEntry(text)
        // The merged card includes row buttons; tap the text's own bounds.
        compose.onNodeWithText(text, useUnmergedTree = true).performClick()
        compose.onNodeWithTag("scratchlist-editor-text").assertIsDisplayed().performTextReplacement("short")
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Delete this scratchlist entry? This cannot be undone.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), store.deletes) }
        compose.onNodeWithTag("scratchlist-cancel-delete").performClick()
        compose.runOnIdle { assertEquals(emptyList<String>(), store.deletes) }
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithTag("scratchlist-confirm-delete").performClick()
        compose.runOnIdle { assertEquals(listOf("entry"), store.deletes) }
    }

    @Test fun anUnsavedLongDraftAlsoRequiresDeletionConfirmation() {
        val store = showEntry("short")
        compose.onNodeWithText("short", useUnmergedTree = true).performClick()
        compose.onNodeWithTag("scratchlist-editor-text").assertIsDisplayed().performTextReplacement("x".repeat(101))
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithText("Delete this scratchlist entry? This cannot be undone.").assertIsDisplayed()
        compose.runOnIdle { assertEquals(emptyList<String>(), store.deletes) }
    }

    @Test fun aShortSavedEntryStillDeletesDirectly() {
        val store = showEntry("short")
        compose.onNodeWithContentDescription("Delete").performClick()
        compose.runOnIdle { assertEquals(listOf("entry"), store.deletes) }
        compose.onNodeWithText("Delete this scratchlist entry? This cannot be undone.").assertDoesNotExist()
    }
}

private class ActionScratchlist(entry: ScratchlistEntry) : SessionScratchlist {
    private val state = MutableStateFlow(ScratchlistSessionState(entries = listOf(entry), loaded = true))
    val deletes = mutableListOf<String>()
    override fun state(sessionId: String) = state
    override fun currentState(sessionId: String) = state.value
    override fun open(sessionId: String) = Unit
    override fun release(sessionId: String) = Unit
    override suspend fun refresh(sessionId: String) = Unit
    override suspend fun createEntry(sessionId: String, text: String, attachments: List<ScratchlistAttachment>): ScratchlistCreateResult = error("unused")
    override suspend fun updateEntry(sessionId: String, entryId: String, text: String?, attachments: List<ScratchlistAttachment>?) = true
    override suspend fun deleteEntry(sessionId: String, entryId: String): Boolean {
        deletes += entryId
        state.value = state.value.copy(entries = emptyList())
        return true
    }
    override fun moveEntry(sessionId: String, entryId: String, direction: ScratchlistMoveDirection) = Unit
    override suspend fun uploadAttachment(sessionId: String, filename: String, bytes: ByteArray, mimeType: String): ScratchlistUploadResult = error("unused")
    override suspend fun deleteAttachment(sessionId: String, attachmentId: String): ScratchlistAttachmentDeleteResult = error("unused")
    override suspend fun limits(sessionId: String) = ScratchlistAttachmentLimits.DEFAULT
}

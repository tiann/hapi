package app.hapi.companion.feature.share

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.SessionListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SyncEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

private class PickerSessions : SessionListStore {
    override val sessions = MutableStateFlow(listOf(
        SessionSummary("active", true, hasConversationContent = true,
            metadata = SessionSummaryMetadata(name = "Active target", path = "/repo/active")),
        SessionSummary("stopped", false, hasConversationContent = true,
            metadata = SessionSummaryMetadata(name = "Stopped target", path = "/repo/stopped")),
    ))
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override suspend fun fullResync() {}
    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {}
    override suspend fun setPinMode(sessionId: String, mode: String): Unit = error("not a picker action")
    override suspend fun archiveSession(sessionId: String): Unit = error("not a picker action")
    override suspend fun renameSession(sessionId: String, name: String): Unit = error("not a picker action")
    override suspend fun deleteSession(sessionId: String): Unit = error("not a picker action")
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse = error("use the gateway")
    override suspend fun updateSessionSummary(sessionId: String, text: String): Unit = error("not a picker action")
    override suspend fun suggestSessionTitle(sessionId: String): String = error("not a picker action")
    override suspend fun titleSuggestionAvailable(): Boolean = false
}

private class PickerMachines : MachineListStore {
    override val machines = MutableStateFlow<List<Machine>>(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

class SharePickerTest {
    @get:Rule val compose = createComposeRule()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private var reopens = 0
    private var switched: String? = null
    private val controller = ShareTargetController(object : ShareSessionGateway {
        override suspend fun isActive(sessionId: String) = sessionId == "active"
        override suspend fun reopen(sessionId: String): String { reopens++; return "replacement" }
    }, scope)
    private val sessions = SessionListViewModel(PickerSessions(), PickerMachines(), LastSeenStore(scope), scope)
    private var batch by mutableStateOf(PendingShare("batch", 1, "shared caption", emptyList()))

    private fun mount() {
        compose.setContent {
            HapiTheme {
                ShareScreen(batch, "https://first.example", listOf("https://first.example", "https://second.example"),
                    sessions, controller, onSwitchHub = { switched = it }, onRetryFile = {},
                    onRemoveFile = { id -> batch = batch.copy(files = batch.files.filterNot { it.id == id }) }, onCancel = {})
            }
        }
        compose.waitUntil(45_000) { sessions.uiState.value.rows.size == 2 }
    }

    @After fun cleanup() { scope.cancel() }

    @Test fun stoppedTargetNeedsExplicitConfirmationAndUsesTheReturnedId() {
        mount()
        compose.onNodeWithTag("share-session-stopped").performClick()
        compose.waitUntil(45_000) { controller.state.value.confirmSessionId != null }
        compose.onNodeWithText(context.getString(R.string.share_restore_message)).assertIsDisplayed()
        assertEquals(0, reopens)
        compose.onNodeWithText(context.getString(R.string.share_restore_confirm)).performClick()
        compose.waitUntil(45_000) { controller.state.value.resolvedSessionId != null }
        assertEquals("replacement", controller.state.value.resolvedSessionId)
        assertEquals(1, reopens)
    }

    @Test fun failedFileBlocksSelectionUntilTheUserRemovesIt() {
        batch = batch.copy(files = listOf(SharedFile("file", "content://source", "bad.pdf", status = SharedFileStatus.Unreadable)))
        mount()
        compose.onNodeWithTag("share-session-active").assertIsNotEnabled()
        compose.onNodeWithText(context.getString(R.string.share_remove)).performClick()
        compose.onNodeWithTag("share-session-active").assertIsEnabled().performClick()
        compose.waitUntil(45_000) { controller.state.value.resolvedSessionId != null }
        assertEquals("active", controller.state.value.resolvedSessionId)
        assertEquals(0, reopens)
    }

    @Test fun pickerOffersPairedHubsAndExistingSessionSearch() {
        mount()
        compose.onNodeWithTag("share-hub").performClick()
        compose.onNodeWithText("second.example").performClick()
        compose.runOnIdle { assertEquals("https://second.example", switched) }
        compose.onNodeWithTag("share-search").performTextInput("Stopped")
        compose.waitUntil(45_000) { sessions.uiState.value.rows.size == 1 }
        compose.onNodeWithTag("share-session-stopped").assertIsDisplayed()
        assertEquals("stopped", sessions.uiState.value.rows.single().id)
    }
}

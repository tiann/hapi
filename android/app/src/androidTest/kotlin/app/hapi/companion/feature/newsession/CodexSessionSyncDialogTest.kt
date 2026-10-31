package app.hapi.companion.feature.newsession

import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.platform.app.InstrumentationRegistry
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.AgentAvailabilityResponse
import app.hapi.protocol.wire.CodexArchiveSessionResponse
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopStatusResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexLocalSessionSummary
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import app.hapi.protocol.wire.CodexMergeDuplicateSessionsResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.GrokModelsResponse
import app.hapi.protocol.wire.MachineListDirectoryResponse
import app.hapi.protocol.wire.MachinePathsExistsResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.SpawnResponse
import app.hapi.protocol.wire.SpawnSessionRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Device coverage for the reviewer's three asks on the codex session-import
 * sheet (PR #2149):
 * 1. rows beyond the capped list's initial viewport stay individually
 *    selectable by scrolling (the list is a bounded [androidx.compose.foundation.lazy.LazyColumn]);
 * 2. a hub switch swaps the imported-markers map (per-hub store) so the
 *    "Imported" badge follows the active hub's markers, not the thread id;
 * 3. Back-dismissing the sheet mid bulk import keeps the outcome observable
 *    on the inline section — "Importing…" while in flight, the formatted
 *    failure once the hung sync resolves.
 *
 * Plus PR #2150: a single-row Confirm whose row was archived externally in
 * the meantime keeps the sheet open with the visible notice and the checked
 * row intact (never a silent close with no selection).
 */
class CodexSessionSyncDialogTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private var scope: CoroutineScope? = null

    private fun newScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scope = it }

    @After
    fun tearDown() {
        scope?.cancel()
    }

    private fun session(
        id: String,
        title: String = "Session $id",
        cwd: String = "/repo/$id",
    ): CodexLocalSessionSummary = CodexLocalSessionSummary(
        id = id,
        title = title,
        lastUserMessage = "Last user message for $id — two lines of preview text to keep every row tall.",
        cwd = cwd,
        file = "/rollout/$id.json",
        modifiedAt = 1_700_000_000_000,
        originator = "codex",
        cliVersion = "0.2.5",
    )

    @Composable
    private fun DialogHarness(state: State<CodexImportUiState>, toggled: MutableList<String>) {
        HapiTheme(dynamicColor = false) {
            if (state.value.open) {
                CodexSessionSyncDialog(
                    state = state.value,
                    onDismiss = {},
                    onToggleSession = { toggled += it },
                    onSelectAll = {},
                    onClearSelection = {},
                    onWorkdirFilterChange = {},
                    onSearchQueryChange = {},
                    onConfirm = {},
                    onArchive = {},
                    onRestart = {},
                )
            }
        }
    }

    private fun waitForTag(tag: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** 1 — the capped history list scrolls: row 16 is past the initial viewport yet selectable. */
    @Test
    fun rowsBeyondTheInitialViewportRemainSelectableByScrolling() {
        val sessions = (1..16).map { session("thread-$it") }
        val state = mutableStateOf(
            CodexImportUiState(open = true, sessions = sessions, machineId = "m1"),
        )
        val toggled = mutableListOf<String>()
        compose.setContent { DialogHarness(state, toggled) }

        waitForTag("codex-sync-session-list")
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_title))
            .assertIsDisplayed()

        // Sixteen tall rows cannot fit the 380 dp cap: the last row is not
        // composed at all until the list scrolls to it.
        assertTrue(
            compose.onAllNodes(hasTestTag("codex-sync-session-thread-16"))
                .fetchSemanticsNodes().isEmpty(),
        )

        compose.onNodeWithTag("codex-sync-session-list")
            .performScrollToNode(hasTestTag("codex-sync-session-thread-16"))
        compose.onNodeWithTag("codex-sync-session-thread-16")
            .performClick()
        compose.runOnIdle { assertEquals(listOf("thread-16"), toggled) }
    }

    /** 2 — imported markers follow the active hub, not the thread id. */
    @Test
    fun importedBadgeFollowsTheHubScopedMarkersMap() {
        val state = mutableStateOf(
            CodexImportUiState(
                open = true,
                sessions = listOf(session("thread-1")),
                machineId = "m1",
                importedMarkers = mapOf("thread-1" to 1L), // imported on hub A
            ),
        )
        compose.setContent { DialogHarness(state, mutableListOf()) }

        val imported = compose.activity.getString(R.string.codex_sync_imported)
        waitForTag("codex-sync-session-list")
        compose.onNodeWithText(imported).assertIsDisplayed()

        // Hub switch (store swap): the same thread id reads un-imported.
        compose.runOnIdle { state.value = state.value.copy(importedMarkers = emptyMap()) }
        compose.onNodeWithText(imported).assertDoesNotExist()
    }

    /** 3 — Back dismissal mid bulk import keeps the outcome visible on the inline section. */
    @Test
    fun backDismissalMidImportKeepsTheOutcomeObservableOnTheSection() {
        val gate = CompletableDeferred<Unit>()
        val gateway = object : NewSessionGateway {
            override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse =
                error("unexpected")

            override suspend fun listDirectory(
                machineId: String,
                path: String,
                includeHidden: Boolean,
            ): MachineListDirectoryResponse = error("unexpected")

            override suspend fun pathsExist(
                machineId: String,
                paths: List<String>,
            ): MachinePathsExistsResponse = error("unexpected")

            override suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse =
                error("unexpected")

            override suspend fun codexModels(machineId: String): CodexModelsResponse =
                error("unexpected")

            override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse =
                error("unexpected")

            override suspend fun getCodexSessions(
                cwd: String?,
                machineId: String?,
            ): CodexLocalSessionsResponse = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
                machineId = "m1",
            )

            override suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse {
                gate.await() // hang the bulk import until the test releases it
                return CodexDesktopScriptResponse(success = false, error = "disk full")
            }

            override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
                error("unexpected")

            // Slice-B seams (PR #2150 line): unused in this test.
            override suspend fun archiveCodexSession(
                sessionId: String,
                machineId: String?,
            ): CodexArchiveSessionResponse = error("unexpected")

            override suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse =
                error("unexpected")

            override suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse =
                error("unexpected")

            override suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse =
                error("unexpected")

            override suspend fun restartCodexDesktop(): CodexDesktopScriptResponse =
                error("unexpected")
        }
        val controller = CodexImportController(
            scope = newScope(),
            gateway = gateway,
            store = MemoryCodexImportedSessionsStore(),
        )
        compose.setContent {
            val state = controller.state.collectAsState()
            HapiTheme(dynamicColor = false) {
                CodexImportSection(
                    state = CodexImportSectionUi(
                        selectedTitle = state.value.selectedSession?.title,
                        loading = state.value.loading,
                        busy = state.value.importing,
                        error = state.value.error ?: state.value.importError,
                    ),
                    isDisabled = false,
                    onChooseHistory = { controller.openDialog("/data/work", "m1") },
                    onClear = {},
                )
                if (state.value.open) {
                    CodexSessionSyncDialog(
                        state = state.value,
                        onDismiss = controller::close,
                        onToggleSession = controller::toggleSession,
                        onSelectAll = controller::selectAll,
                        onClearSelection = controller::clearSelection,
                        onWorkdirFilterChange = controller::setWorkdirFilter,
                        onSearchQueryChange = controller::setSearchQuery,
                        onConfirm = controller::confirm,
                        onArchive = {},
                        onRestart = {},
                    )
                }
            }
        }

        // Open the sheet and load the two sessions.
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_inline_choose))
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.sessions.size == 2 }
        compose.onNodeWithTag("codex-sync-session-a").performClick()
        compose.onNodeWithTag("codex-sync-session-b").performClick()

        // Two rows checked → bulk import, hanging on the gate.
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_import))
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.importing }

        // Back-dismiss the in-flight sheet: the pending state must not vanish
        // with it — the section's button keeps showing the in-flight label.
        // Real Back key event (what a user presses): the sheet's dialog
        // window consumes it and fires onDismissRequest.
        InstrumentationRegistry.getInstrumentation()
            .sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitUntil(10_000) { !controller.state.value.open }
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_title))
            .assertDoesNotExist()
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_importing))
            .assertIsDisplayed()

        // The hung import now fails: the formatted failure lands on the
        // section (web toasts it; Android's toast host is this error line).
        gate.complete(Unit)
        compose.waitUntil(10_000) { controller.state.value.importError != null }
        compose.onNodeWithText("Import failed: disk full").assertIsDisplayed()
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_inline_choose))
            .assertIsDisplayed()
    }

    /** 4 — single-row Confirm on an externally archived row keeps the sheet open (PR #2150). */
    @Test
    fun confirmWithAnExternallyArchivedRowKeepsTheSheetOpen() {
        val gateway = object : NewSessionGateway {
            override suspend fun spawn(machineId: String, request: SpawnSessionRequest): SpawnResponse =
                error("unexpected")

            override suspend fun listDirectory(
                machineId: String,
                path: String,
                includeHidden: Boolean,
            ): MachineListDirectoryResponse = error("unexpected")

            override suspend fun pathsExist(
                machineId: String,
                paths: List<String>,
            ): MachinePathsExistsResponse = error("unexpected")

            override suspend fun agentAvailability(machineId: String): AgentAvailabilityResponse =
                error("unexpected")

            override suspend fun codexModels(machineId: String): CodexModelsResponse =
                error("unexpected")

            override suspend fun grokModels(machineId: String, cwd: String): GrokModelsResponse =
                error("unexpected")

            override suspend fun getCodexSessions(
                cwd: String?,
                machineId: String?,
            ): CodexLocalSessionsResponse = CodexLocalSessionsResponse(
                success = true,
                sessions = listOf(session("a"), session("b")),
                machineId = "m1",
            )

            // A single vanished row must never reach the sync call.
            override suspend fun syncCodexSession(sync: CodexDesktopSyncRequest): CodexDesktopScriptResponse =
                error("unexpected")

            override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
                error("unexpected")

            // The external archive (e.g. from the desktop client) succeeds.
            override suspend fun archiveCodexSession(
                sessionId: String,
                machineId: String?,
            ): CodexArchiveSessionResponse = CodexArchiveSessionResponse(success = true)

            override suspend fun getCodexDesktopStatus(): CodexDesktopStatusResponse =
                error("unexpected")

            override suspend fun getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexDuplicateSessionsResponse =
                error("unexpected")

            override suspend fun mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): CodexMergeDuplicateSessionsResponse =
                error("unexpected")

            override suspend fun restartCodexDesktop(): CodexDesktopScriptResponse =
                error("unexpected")
        }
        val controller = CodexImportController(
            scope = newScope(),
            gateway = gateway,
            store = MemoryCodexImportedSessionsStore(),
        )
        compose.setContent {
            val state = controller.state.collectAsState()
            HapiTheme(dynamicColor = false) {
                if (state.value.open) {
                    CodexSessionSyncDialog(
                        state = state.value,
                        onDismiss = controller::close,
                        onToggleSession = controller::toggleSession,
                        onSelectAll = controller::selectAll,
                        onClearSelection = controller::clearSelection,
                        onWorkdirFilterChange = controller::setWorkdirFilter,
                        onSearchQueryChange = controller::setSearchQuery,
                        onConfirm = controller::confirm,
                        onArchive = controller::archive,
                        onRestart = controller::restart,
                    )
                }
            }
        }

        // This harness mounts only the sheet (no inline section), so the
        // dialog opens directly.
        compose.runOnIdle { controller.openDialog("/data/work", "m1") }
        compose.waitUntil(10_000) { controller.state.value.sessions.size == 2 }
        compose.onNodeWithTag("codex-sync-session-a").performClick()
        compose.waitUntil(10_000) { controller.state.value.dialogSelection == setOf("a") }

        // The checked row is archived externally before Confirm: the row
        // disappears while the checkbox state keeps pointing at it.
        compose.runOnIdle { controller.archive("a") }
        compose.waitUntil(10_000) { controller.state.value.sessions.size == 1 }

        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_import))
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.confirmSelectionMissing }

        // The sheet stays open with the visible notice and the selection
        // intact — never a silent close with no selection at all.
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_title))
            .assertIsDisplayed()
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_confirm_selection_missing))
            .assertIsDisplayed()
        assertTrue(controller.state.value.dialogSelection == setOf("a"))
    }
}

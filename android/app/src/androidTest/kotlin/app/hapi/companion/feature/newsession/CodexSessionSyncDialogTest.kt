package app.hapi.companion.feature.newsession

import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
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
 * 3. Dismissing the sheet mid bulk import (outside tap, Back as fallback)
 *    keeps the outcome observable on the inline section — "Importing…" while
 *    in flight, the formatted failure once the hung sync resolves.
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

    /**
     * Scrolls the dialog's sheet content column towards its bottom the way a
     * user does — repeated drag gestures starting on the (non-scrollable)
     * title header — until [target]'s center is inside the visible screen.
     * On the CI's 320x640dp screens the header stack pushes the capped list,
     * notices and buttons below the fold, `performScrollTo` cannot help (its
     * ScrollBy dispatch moves nothing in this sheet — verified by dumping
     * node geometry before/after: identical bounds), and a single 360dp drag
     * is not enough either (the sheet consumes part of the gesture before
     * the column scrolls), so the helper loops and re-measures instead of
     * trusting any one drag distance. Taps at off-screen coordinates hit
     * nothing (no auto-scroll), so every tap below the fold must be
     * preceded by scrolling its target genuinely on screen.
     */
    private fun scrollSheetContentUp(target: SemanticsMatcher) {
        val screenBottom = compose.activity.resources.displayMetrics.heightPixels.toFloat()
        fun targetOnScreen() = compose.onAllNodes(target).fetchSemanticsNodes().firstOrNull()
            ?.let { it.positionInRoot.y + it.size.height / 2f < screenBottom - 8f } == true
        var drags = 0
        while (!targetOnScreen() && drags < 8) {
            compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_title))
                .performTouchInput { swipe(center, Offset(center.x, center.y - 300f), 400) }
            drags++
        }
        assertTrue("sheet never scrolled the target on screen after $drags drags", targetOnScreen())
    }

    /**
     * Taps the scrim above the collapsed (half-expanded) sheet through the
     * real system input pipeline: `sendPointerSync` injects at the system
     * level, so the window manager routes the tap to the topmost window at
     * the coordinates — the sheet's dialog window — where the scrim's
     * tap gesture fires the sheet's outside-dismiss. Compose's
     * `performTouchInput` cannot do this: it dispatches inside the tapped
     * node's own window and never crosses into the dialog window. Only call
     * this while the sheet is collapsed — an expanded sheet's body covers
     * the scrim, so the tap would land on sheet content instead.
     */
    private fun tapOnScrimAboveTheSheet() {
        val metrics = compose.activity.resources.displayMetrics
        val x = metrics.widthPixels / 2f
        // A quarter of the screen height sits safely between the status bar
        // and the half-expanded sheet's top (the sheet starts ~57% down on
        // the CI's 320x640dp emulators, verified via node-geometry dumps).
        val y = metrics.heightPixels / 4f
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(
            MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0),
        )
        instrumentation.sendPointerSync(
            MotionEvent.obtain(down, down + 64L, MotionEvent.ACTION_UP, x, y, 0),
        )
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
        // Composing the row is not enough on the CI's 320x640dp screens: the
        // capped list extends below the sheet's fold, so the row's laid-out
        // center is off screen. Drag the sheet content up (see helper) until
        // row 16's center is genuinely on screen before the tap.
        scrollSheetContentUp(hasTestTag("codex-sync-session-thread-16"))
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
        // On the CI's 320x640dp screens the capped list starts below the
        // sheet's fold (see test 1), so the badge row is laid out but not
        // displayed. Drag the sheet content up to bring it on screen.
        scrollSheetContentUp(hasText(imported))
        compose.onNodeWithText(imported)
            .assertIsDisplayed()

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
        // Bring the two-row list and the Confirm button on screen with the
        // real drag gesture (see helper) — their laid-out centers sit below
        // the sheet's fold on the CI's 320x640dp screens (test 1). The rows
        // sit above the button, so a button on screen carries them too.
        scrollSheetContentUp(hasText(compose.activity.getString(R.string.codex_sync_import)))
        compose.onNodeWithTag("codex-sync-session-a")
            .performClick()
        compose.onNodeWithTag("codex-sync-session-b")
            .performClick()

        // Two rows checked → bulk import, hanging on the gate. The Confirm
        // button is now on screen after the drag above.
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_import))
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.importing }

        // Dismiss the in-flight sheet the way a user does: the pending state
        // must not vanish with it — the section's button keeps showing the
        // in-flight label. The drag-scrolling above may have left the sheet
        // EXPANDED (over-scroll passes through the sheet's nested scroll, and
        // this short two-row content has no column scroll to consume it), and
        // M3 routes Back on an expanded sheet to a collapse — partialExpand,
        // not onDismissRequest — while the expanded sheet body also covers
        // the scrim. So the test drives the sequence a user facing an
        // expanded sheet would: Back first (collapse, or dismiss if already
        // half), then a system-level tap on the scrim that only the collapsed
        // sheet exposes (see helper), with one more Back as the final
        // fallback.
        InstrumentationRegistry.getInstrumentation()
            .sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        try {
            compose.waitUntil(3_000) { !controller.state.value.open }
        } catch (expected: Throwable) {
            tapOnScrimAboveTheSheet()
        }
        try {
            compose.waitUntil(3_000) { !controller.state.value.open }
        } catch (expected: Throwable) {
            InstrumentationRegistry.getInstrumentation()
                .sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        }
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
        // Bring row a on screen with the real drag gesture (see helper) —
        // its laid-out center sits below the sheet's fold on the CI's
        // 320x640dp screens (test 1).
        scrollSheetContentUp(hasTestTag("codex-sync-session-a"))
        compose.onNodeWithTag("codex-sync-session-a")
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.dialogSelection == setOf("a") }

        // The checked row is archived externally before Confirm: the row
        // disappears while the checkbox state keeps pointing at it.
        compose.runOnIdle { controller.archive("a") }
        compose.waitUntil(10_000) { controller.state.value.sessions.size == 1 }

        // The archive shrank the content, so drag again to pin the Confirm
        // button on screen before tapping it.
        scrollSheetContentUp(hasText(compose.activity.getString(R.string.codex_sync_import)))
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_import))
            .performClick()
        compose.waitUntil(10_000) { controller.state.value.confirmSelectionMissing }

        // The armed notice inserts itself above the button, which pushes the
        // button row back below the fold (the column's scroll position is
        // top-anchored), so drag once more until the notice itself is on
        // screen. The sheet sits at its bottom after that drag, so the title
        // may legitimately be scrolled off the top: presence (not on-screen
        // display) is the "still open" proof here — the notice assert below
        // is itself sheet content and must be displayed.
        scrollSheetContentUp(hasText(compose.activity.getString(R.string.codex_sync_confirm_selection_missing)))
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_title))
            .assertExists()
        compose.onNodeWithText(compose.activity.getString(R.string.codex_sync_confirm_selection_missing))
            .assertIsDisplayed()
        assertTrue(controller.state.value.dialogSelection == setOf("a"))
    }
}

package app.hapi.companion.feature.newsession

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.PiLocalSessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Device coverage for the reviewer's capped-list scrolling ask on the pi
 * session-import sheet (PR #2151): rows beyond the capped list's initial
 * viewport stay individually selectable by scrolling (the list is a bounded
 * [androidx.compose.foundation.lazy.LazyColumn] — the twin of the codex
 * dialog's fix from PR #2149).
 */
class PiSessionImportDialogTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun session(
        id: String,
        title: String = "Session $id",
    ): PiLocalSessionSummary = PiLocalSessionSummary(
        id = id,
        title = title,
        lastUserMessage = "Last user message for $id — two lines of preview text to keep every row tall.",
        cwd = "/repo/$id",
        file = "/pi/$id.jsonl",
        modifiedAt = 1_700_000_000_000,
        messageCount = 2,
    )

    @Composable
    private fun DialogHarness(state: State<PiImportUiState>, toggled: MutableList<String>) {
        HapiTheme(dynamicColor = false) {
            if (state.value.open) {
                PiSessionImportDialog(
                    state = state.value,
                    onDismiss = {},
                    onToggleSession = { toggled += it },
                    onSelectAll = {},
                    onClearSelection = {},
                    onDirectoryFilterChange = {},
                    onSearchQueryChange = {},
                    onConfirm = {},
                )
            }
        }
    }

    private fun waitForTag(tag: String) {
        compose.waitUntil(10_000) {
            compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** The capped pi history list scrolls: row 16 is past the initial viewport yet selectable. */
    @Test
    fun rowsBeyondTheInitialViewportRemainSelectableByScrolling() {
        val sessions = (1..16).map { session("pi-$it") }
        val state = mutableStateOf(
            PiImportUiState(open = true, sessions = sessions, machineId = "m1"),
        )
        val toggled = mutableListOf<String>()
        compose.setContent { DialogHarness(state, toggled) }

        waitForTag("pi-import-session-list")
        compose.onNodeWithText(compose.activity.getString(R.string.pi_import_dialog_title))
            .assertIsDisplayed()

        // Sixteen tall rows cannot fit the 380 dp cap: the last row is not
        // composed at all until the list scrolls to it.
        assertTrue(
            compose.onAllNodes(hasTestTag("pi-import-session-pi-16"))
                .fetchSemanticsNodes().isEmpty(),
        )

        compose.onNodeWithTag("pi-import-session-list")
            .performScrollToNode(hasTestTag("pi-import-session-pi-16"))
        compose.onNodeWithTag("pi-import-session-pi-16")
            .performClick()
        compose.runOnIdle { assertEquals(listOf("pi-16"), toggled) }
    }
}

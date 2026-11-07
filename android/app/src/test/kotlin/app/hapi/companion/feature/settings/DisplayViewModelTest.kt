package app.hapi.companion.feature.settings

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * Display-subpage state: every setter is one [DisplayPrefs.update] — the tests
 * drive the VM against the in-memory fake and assert both the emitted UI state
 * (turbine) and the persisted snapshot.
 */
class DisplayViewModelTest {

    @Test
    fun `setters persist field changes through the prefs store`() = runTest {
        val prefs = InMemoryDisplayPrefs()
        val viewModel = DisplayViewModel(prefs, backgroundScope)

        viewModel.settings.test {
            assertEquals(DisplaySettings(), awaitItem())

            viewModel.setSessionPreviewLimit(200) // out of range → clamped
            assertEquals(99, awaitItem().sessionPreviewLimit)

            viewModel.setShowActiveSessionsOnly(true)
            assertTrue(awaitItem().showActiveSessionsOnly)

            viewModel.setPinInProgressSessions(true)
            assertTrue(awaitItem().pinInProgressSessions)

            viewModel.setSessionListStatusMode(SessionListStatusMode.DETAILED)
            assertEquals(SessionListStatusMode.DETAILED, awaitItem().sessionListStatusMode)

            viewModel.setFontScale(AppFontScale.XXL)
            assertEquals(AppFontScale.XXL, awaitItem().fontScale)

            viewModel.setHeaderMetadata(SessionHeaderMetadata(agent = false))
            assertFalse(awaitItem().headerMetadata.agent)

            cancelAndIgnoreRemainingEvents()
        }

        // The setters went through prefs.update — the store, not just UI state.
        assertEquals(99, prefs.settings.value.sessionPreviewLimit)
        assertEquals(AppFontScale.XXL, prefs.settings.value.fontScale)
        assertFalse(prefs.settings.value.headerMetadata.agent)
    }

    @Test
    fun `state starts at web-aligned defaults before any setter runs`() = runTest {
        val viewModel = DisplayViewModel(InMemoryDisplayPrefs(), backgroundScope)
        assertEquals(DisplaySettings(), viewModel.settings.value)
    }
}

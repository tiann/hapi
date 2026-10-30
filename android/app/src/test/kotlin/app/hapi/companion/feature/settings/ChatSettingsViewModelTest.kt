package app.hapi.companion.feature.settings

import app.cash.turbine.test
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

/**
 * Chat-subpage state: every setter is one [ChatPrefs.update] — the tests drive
 * the VM against the in-memory fake and assert both the emitted UI state
 * (turbine) and the persisted snapshot.
 */
class ChatSettingsViewModelTest {

    @Test
    fun `setters persist field changes through the prefs store`() = runTest {
        val prefs = InMemoryChatPrefs()
        val viewModel = ChatSettingsViewModel(prefs, backgroundScope)

        viewModel.settings.test {
            assertEquals(ChatSettings(), awaitItem())

            viewModel.setEnterBehavior(ComposerEnterBehavior.SEND)
            assertEquals(ComposerEnterBehavior.SEND, awaitItem().enterBehavior)

            viewModel.setReasoningCollapsed(false)
            assertFalse(awaitItem().reasoningCollapsed)

            viewModel.setToolCardsCollapsed(true)
            assertTrue(awaitItem().toolCardsCollapsed)

            viewModel.setToolGroupBackground(ChatSurfaceColor.SOFT_BLUE)
            assertEquals(ChatSurfaceColor.SOFT_BLUE, awaitItem().toolGroupBackground)

            viewModel.setUserMessageBackground(ChatSurfaceColor.SOFT_YELLOW)
            assertEquals(ChatSurfaceColor.SOFT_YELLOW, awaitItem().userMessageBackground)

            cancelAndIgnoreRemainingEvents()
        }

        // The setters went through prefs.update — the store, not just UI state.
        assertEquals(ComposerEnterBehavior.SEND, prefs.settings.value.enterBehavior)
        assertFalse(prefs.settings.value.reasoningCollapsed)
        assertTrue(prefs.settings.value.toolCardsCollapsed)
        assertEquals(ChatSurfaceColor.SOFT_BLUE, prefs.settings.value.toolGroupBackground)
        assertEquals(ChatSurfaceColor.SOFT_YELLOW, prefs.settings.value.userMessageBackground)
    }

    @Test
    fun `state starts at the documented defaults before any setter runs`() = runTest {
        val viewModel = ChatSettingsViewModel(InMemoryChatPrefs(), backgroundScope)
        assertEquals(ChatSettings(), viewModel.settings.value)
    }
}

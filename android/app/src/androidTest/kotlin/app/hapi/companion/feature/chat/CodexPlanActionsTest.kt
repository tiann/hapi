package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import app.hapi.companion.feature.chat.blocks.ToolCallBlockView
import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ToolCallBlock
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CodexPlanActionsTest {
    @get:Rule val compose = createComposeRule()

    private fun proposal(name: String = "ExitPlanMode"): ToolCallBlock {
        val block = previewToolCall("message", name, input = mapOf("plan" to "# Plan document\n\nKeep the complete proposal."))
        return ToolCallBlock(id = block.id, localId = null, createdAt = 0, invokedAt = null,
                             tool = block.tool.copy(id = "proposal"), children = emptyList(), meta = null)
    }

    @Test fun liveMenuUsesToolIdAndRetainsPendingAndErrorStateWithoutPermissions() {
        val state = mutableStateOf(CodexPlanActions(proposalId = "proposal"))
        val implemented = mutableListOf<String>()
        val continued = mutableListOf<String>()
        compose.setContent {
            HapiTheme {
                CompositionLocalProvider(LocalChatInteractions provides ChatInteractions(
                    flavor = "codex", permissionOverrides = emptyMap(),
                    resolvePermission = { _, _ -> error("Plan is not a permission") }, retryFailedMessage = {},
                    codexPlanActions = state.value,
                    implementCodexPlan = { implemented += it; state.value = state.value.copy(pendingPlanId = it) },
                    continueCodexPlan = { continued += it },
                )) {
                    Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBlockView(proposal(), null) }
                }
            }
        }
        compose.onNodeWithText("Plan document").assertIsDisplayed()
        compose.onNodeWithText("Awaiting approval").assertDoesNotExist()
        compose.onNodeWithTag("plan-implement-proposal").performScrollTo().assertIsEnabled()
        compose.onNodeWithTag("plan-continue-proposal").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("proposal"), continued) }
        // Folding a plan only hides its document, not its action/status footer.
        compose.onNodeWithText("Plan proposal").performScrollTo().performClick()
        compose.onNodeWithText("Plan document").assertDoesNotExist()
        compose.onNodeWithTag("plan-implement-proposal").performScrollTo().performClick()
        compose.onNodeWithTag("plan-implement-proposal").assertIsNotEnabled()
        compose.onNodeWithTag("plan-continue-proposal").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(listOf("proposal"), implemented)
            state.value = state.value.copy(proposalId = null)
        }
        compose.onNodeWithTag("plan-implement-proposal").assertIsNotEnabled()
        compose.runOnIdle { state.value = CodexPlanActions(errors = mapOf("proposal" to CodexPlanFailure("Not confirmed"))) }
        compose.onNodeWithTag("plan-implement-proposal").assertDoesNotExist()
        compose.onNodeWithText("Not confirmed").assertIsDisplayed()
        compose.onNodeWithText("Plan proposal").performClick()
        compose.onNodeWithText("Plan document").assertIsDisplayed()
        compose.runOnIdle { state.value = CodexPlanActions(proposalId = "child-plan") }
        compose.onNodeWithTag("plan-continue-proposal").assertDoesNotExist()
        compose.onNodeWithText("Not confirmed").assertDoesNotExist()
        compose.onNodeWithText("Plan document").assertIsDisplayed()
    }

    @Test fun continueButtonFocusesTheComposerAndPreservesDraftAtLargeFontScale() {
        val composer = mutableStateOf(ComposerUiState(text = "Refine step two", isSending = false, canSteer = false))
        compose.setContent {
            HapiTheme(darkTheme = true, dynamicColor = false) {
                CompositionLocalProvider(
                    LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f),
                    LocalChatInteractions provides ChatInteractions(
                        flavor = "codex", permissionOverrides = emptyMap(), resolvePermission = { _, _ -> }, retryFailedMessage = {},
                        codexPlanActions = CodexPlanActions(proposalId = "proposal"),
                        continueCodexPlan = { composer.value = composer.value.copy(focusRequest = composer.value.focusRequest + 1) },
                    ),
                ) {
                    Column(Modifier.fillMaxSize()) {
                        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                            ToolCallBlockView(proposal("exit_plan_mode"), null)
                        }
                        ChatComposer(state = composer.value, onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {})
                    }
                }
            }
        }
        compose.onNodeWithTag("chat-composer-input").assertIsNotFocused()
        compose.onNodeWithTag("plan-continue-proposal").performScrollTo().assertIsDisplayed().performClick()
        compose.onNodeWithTag("chat-composer-input").assertIsFocused().assertTextContains("Refine step two")
        compose.runOnIdle { assertEquals("Refine step two", composer.value.text) }
    }
}

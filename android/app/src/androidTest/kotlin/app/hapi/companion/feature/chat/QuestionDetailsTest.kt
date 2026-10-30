package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import app.hapi.companion.feature.chat.blocks.PendingPermissionFooter
import app.hapi.companion.feature.chat.blocks.ToolCallBody
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class QuestionDetailsTest {
    @get:Rule val compose = createComposeRule()
    private val input = HapiJson.parseToJsonElement("""{"questions":[{"id":"target","question":"部署到哪里？ **Choose a target**","prefill":"production","options":[{"label":"staging","description":"Safe for testing"},{"label":"production","description":"Live traffic"}]}]}""")
    private fun pending() = ChatToolCall(id = "question", name = "request_user_input", state = "running", input = input,
        createdAt = 0, description = null, permission = ToolPermission(id = "reply", status = "pending", presence = emptySet()))

    private fun otherTool(multiple: Boolean = false) = pending().copy(input = HapiJson.parseToJsonElement(
        """{"questions":[{"id":"target","question":"Choose","isOther":true,"multiple":$multiple,"options":[{"label":"Alpha"},{"label":"Beta"}]}]}""",
    ))

    @Test fun otherChoiceFocusesOptionalNotesAndSubmitsWithoutAnyNote() {
        val submitted = mutableListOf<Pair<String, PermissionAction>>()
        compose.setContent {
            HapiTheme { PendingPermissionFooter(tool = otherTool(), requestId = "reply", flavor = "codex", override = null,
                onAction = { id, action -> submitted += id to action }) }
        }
        compose.onNodeWithTag("request-input-target-option-0").performClick()
        compose.onNodeWithTag("request-input-target-option-2").performClick().assertIsSelected()
        compose.onNodeWithTag("request-input-target-option-0").assertIsNotSelected()
        compose.onNodeWithTag("request-input-target-note").assertIsFocused()
        compose.runOnIdle { assertEquals(emptyList<Pair<String, PermissionAction>>(), submitted) }
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle {
            assertEquals(listOf("reply" to PermissionAction.NestedAnswers(mapOf("target" to listOf("None of the above")))), submitted)
        }
    }

    @Test fun otherChoiceIsExclusiveAndRestoresNotesWithoutChangingWireValues() {
        val restoration = StateRestorationTester(compose)
        var submitted: PermissionAction? = null
        restoration.setContent {
            HapiTheme { PendingPermissionFooter(tool = otherTool(multiple = true), requestId = "reply", flavor = "codex", override = null,
                onAction = { _, action -> submitted = action }) }
        }
        compose.onNodeWithTag("request-input-target-option-0").performClick()
        compose.onNodeWithTag("request-input-target-option-1").performClick()
        compose.onNodeWithTag("request-input-target-option-2").performClick()
        compose.onNodeWithTag("request-input-target-note").performTextInput("  自定义\n说明  ")
        compose.onNodeWithTag("request-input-target-option-1").performClick().assertIsSelected()
        compose.onNodeWithTag("request-input-target-option-2").assertIsNotSelected().performClick()
        compose.onNodeWithTag("request-input-target-option-0").assertIsNotSelected()
        compose.onNodeWithTag("request-input-target-option-1").assertIsNotSelected()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("request-input-target-option-2").assertIsSelected()
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle {
            assertEquals(PermissionAction.NestedAnswers(mapOf("target" to listOf("None of the above", "user_note: 自定义\n说明"))), submitted)
        }
    }

    @Test fun recordedOtherAnswerIsSelectedReadOnlyAndKeepsItsNote() {
        val tool = otherTool().copy(state = "completed", result = HapiJson.parseToJsonElement(
            """{"answers":{"target":{"answers":["None of the above","user_note: recorded note"]}}}""",
        ))
        compose.setContent {
            HapiTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBody(tool, basePath = null) } }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("None of the above").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("question-0-option-2").assertIsSelected().assertHasNoClickAction()
        compose.onNodeWithText("recorded note").performScrollTo().assertIsDisplayed()
    }

    @Test fun detailsFollowLiveAnswersWithoutActionsAndKeepSourceAndErrorsAccessible() {
        val tool = mutableStateOf(pending())
        compose.setContent {
            HapiTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBody(tool.value, basePath = null) } }
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("staging").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("question-0-option-1").assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
        compose.onNodeWithText("Submit").assertDoesNotExist()
        compose.runOnIdle {
            tool.value = tool.value.copy(state = "completed", result = JsonPrimitive("duplicate result"),
                permission = ToolPermission(id = "reply", status = "approved", presence = emptySet(),
                    answers = HapiJson.parseToJsonElement("""{"target":{"answers":["staging","user_note: after tests"]}}""")))
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Questions & Answers").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("question-0-option-0").assertIsSelected().assertHasNoClickAction()
        compose.onNodeWithTag("question-0-option-1").assertIsNotSelected().assertHasNoClickAction()
        compose.onNodeWithText("after tests").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("duplicate result").assertDoesNotExist()
        compose.onNodeWithText("Source").performScrollTo().performClick()
        // Source JSON prepares off-main; wait for the content above Answers
        // to acquire its final height before checking scroll-to visibility.
        compose.waitUntil(10_000) { compose.onAllNodesWithText("\"questions\"", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Answers").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Source").performScrollTo().performClick()
        compose.runOnIdle { tool.value = tool.value.copy(state = "error", result = JsonPrimitive("answer delivery failed")) }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("answer delivery failed", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("answer delivery failed", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Submit").assertDoesNotExist()
    }

    @Test fun existingPendingAnswerFormStillSubmitsNestedAnswers() {
        var resolved: Pair<String, PermissionAction>? = null
        compose.setContent {
            HapiTheme {
                PendingPermissionFooter(tool = pending(), requestId = "reply", flavor = "codex", override = null,
                    onAction = { id, action -> resolved = id to action })
            }
        }
        compose.onNodeWithText("staging").performClick()
        compose.onNodeWithTag("request-input-target-option-2").assertDoesNotExist()
        compose.onNodeWithText("Submit").performClick()
        compose.runOnIdle {
            assertEquals("reply" to PermissionAction.NestedAnswers(mapOf("target" to listOf("staging", "user_note: production"))), resolved)
        }
    }
}

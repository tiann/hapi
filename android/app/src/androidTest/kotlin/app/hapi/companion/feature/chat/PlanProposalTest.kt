package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.hapi.companion.feature.chat.blocks.ToolCallBlockView
import app.hapi.companion.feature.chat.blocks.previewToolCall
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolCallBlock
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PlanProposalTest {
    @get:Rule val compose = createComposeRule()

    private fun ToolCallBlock.withTool(value: ChatToolCall) = ToolCallBlock(
        id = id, localId = localId, createdAt = createdAt, invokedAt = invokedAt,
        tool = value, children = children, meta = meta,
    )

    @Test fun plansStartExpandedUpdateInPlaceAndKeepSourceAndErrors() {
        val block = mutableStateOf(previewToolCall("proposal", "ExitPlanMode", input = mapOf("plan" to "# 实施计划\n\nRead **input.plan**.")))
        block.value = block.value.withTool(block.value.tool.copy(result = JsonNull))
        val projection = TranscriptProjection()
        compose.setContent {
            HapiTheme {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    ToolCallBlockView(projection.project(listOf(block.value)).single() as ToolCallBlock, null)
                }
            }
        }
        compose.onNodeWithText("实施计划").assertIsDisplayed()
        compose.onNodeWithText("Read input.plan.").assertIsDisplayed()
        compose.onNodeWithText("Input").assertDoesNotExist()
        compose.onNodeWithText("Result").assertDoesNotExist()
        compose.onNodeWithText("Awaiting approval").assertDoesNotExist()
        compose.onNodeWithText("Plan proposal").performClick()
        compose.onNodeWithText("实施计划").assertDoesNotExist()
        // The same call keeps the user's explicit folding through updates.
        compose.runOnIdle {
            block.value = block.value.withTool(block.value.tool.copy(input = JsonObject(mapOf("plan" to JsonPrimitive("# Revised plan\n\nUpdated document.")))))
        }
        compose.onNodeWithText("Revised plan").assertDoesNotExist()
        compose.onNodeWithText("Plan proposal").performClick()
        compose.onNodeWithText("Revised plan").assertIsDisplayed()
        compose.onNodeWithText("实施计划").assertDoesNotExist()
        compose.onNodeWithText("Source").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("\"plan\"", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Input").assertIsDisplayed()
        compose.onNodeWithText("Source").performClick()
        compose.runOnIdle {
            block.value = block.value.withTool(block.value.tool.copy(state = "error", result = JsonPrimitive("Plan failed to apply")))
        }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Plan failed to apply", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Plan failed to apply", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test fun lowercaseProposalOpensWhenInputArrivesAndPrecedesApproval() {
        val block = mutableStateOf(previewToolCall("proposal", "unknown"))
        compose.setContent {
            HapiTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBlockView(block.value, null) } }
        }
        compose.runOnIdle {
            block.value = previewToolCall("proposal", "exit_plan_mode", input = mapOf("plan" to "## Review first\n\nThen approve."),
                permission = ToolPermission(id = "approval", status = "pending", presence = emptySet()))
        }
        compose.onNodeWithText("Review first").assertIsDisplayed()
        val document = compose.onNodeWithText("Then approve.").fetchSemanticsNode().boundsInRoot
        val approval = compose.onNodeWithText("⏳ Awaiting approval").fetchSemanticsNode().boundsInRoot
        assertTrue("Read the plan before approval", document.bottom <= approval.top)
    }

    @Test fun longPlansRemainFullMarkdownInsteadOfPagedToolSource() {
        val source = "# Long plan\n\n" + "A complete paragraph 中文. ".repeat(1_000) + "\n\n## Last heading"
        assertTrue(source.length > 20_000)
        val block = previewToolCall("long-plan", "exit_plan_mode", input = mapOf("plan" to source))
        compose.setContent {
            HapiTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBlockView(block, null) } }
        }
        compose.onNodeWithText("Long plan").assertIsDisplayed()
        compose.onNodeWithText("Last heading").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Load more content").assertDoesNotExist()
        compose.onNodeWithText("Source").assertExists()
    }

    @Test fun ordinaryToolsRemainCollapsedAndMalformedPlanInputStaysAccessible() {
        val block = mutableStateOf(previewToolCall("ordinary", "Bash", input = mapOf("command" to "echo hidden")))
        compose.setContent {
            HapiTheme { Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBlockView(block.value, null) } }
        }
        compose.onNodeWithText("Source").assertDoesNotExist()
        compose.runOnIdle { block.value = previewToolCall("malformed", "ExitPlanMode", input = mapOf("unexpected" to "retained")) }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("retained", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("retained", substring = true).assertIsDisplayed()
    }

    @Test fun plansReflowAcrossThemeAndFontScaleChanges() {
        val dark = mutableStateOf(false)
        val scale = mutableStateOf(1f)
        val plan = "# 实施计划\n\n- Inspect **input.plan**\n\n| Client | Ready |\n| --- | --- |\n| Android | Yes |\n\n```kotlin\nval ready = true\n```\n\n[Documentation](https://hapi.run)\n\nEnd of plan"
        val block = previewToolCall("theme-plan", "ExitPlanMode", input = mapOf("plan" to plan))
        compose.setContent {
            HapiTheme(darkTheme = dark.value, dynamicColor = false) {
                CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = scale.value)) {
                    Column(Modifier.verticalScroll(rememberScrollState())) { ToolCallBlockView(block, null) }
                }
            }
        }
        compose.onNodeWithText("实施计划").assertIsDisplayed()
        val normalHeight = compose.onNodeWithText("End of plan").fetchSemanticsNode().boundsInRoot.height
        compose.runOnIdle { dark.value = true }
        compose.onNodeWithText("End of plan").performScrollTo().assertIsDisplayed()
        compose.runOnIdle { scale.value = 2f }
        compose.onNodeWithText("实施计划").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("End of plan").performScrollTo().assertIsDisplayed()
        assertTrue(compose.onNodeWithText("End of plan").fetchSemanticsNode().boundsInRoot.height > normalHeight)
    }
}

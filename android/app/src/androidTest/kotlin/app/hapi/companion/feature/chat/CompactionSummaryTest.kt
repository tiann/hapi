package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import app.hapi.companion.feature.chat.blocks.AgentEventBlockView
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.AgentEvent
import app.hapi.protocol.chat.AgentEventBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Rule
import org.junit.Test

class CompactionSummaryTest {
    @get:Rule val compose = createComposeRule()

    private fun block(summary: String = "", vararg facts: Pair<String, Number>) = AgentEventBlock(
        id = "compact", createdAt = 0, invokedAt = null, meta = null,
        event = AgentEvent.of(JsonObject(mapOf("type" to JsonPrimitive("compact-summary"), "summary" to JsonPrimitive(summary)) +
            facts.associate { it.first to JsonPrimitive(it.second) })),
    )

    @Test fun realSummaryStartsCollapsedAndExpandsFullMarkdownAcrossLateFacts() {
        val state = mutableStateOf(block("# Checkpoint\n\nSaved **answer**."))
        compose.setContent {
            HapiTheme { Column { Text("Real prompt"); AgentEventBlockView(state.value); Text("Real answer") } }
        }
        compose.onNodeWithTag("compaction-header-compact").assertHasClickAction()
        compose.onNodeWithText("Checkpoint").assertDoesNotExist()
        compose.onNodeWithText("Real prompt").assertIsDisplayed()
        compose.onNodeWithText("Real answer").assertIsDisplayed()
        compose.onNodeWithTag("compaction-header-compact").performClick()
        compose.onNodeWithText("Checkpoint").assertIsDisplayed()
        compose.onNodeWithText("Saved answer.").assertIsDisplayed()
        compose.runOnIdle { state.value = block("# Revised checkpoint\n\nStill readable.", "estimatedTokensAfter" to 40) }
        compose.onNodeWithText("Revised checkpoint").assertIsDisplayed()
        compose.onNodeWithText("~40 tokens after (estimated)", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("compaction-header-compact").performClick()
        compose.onNodeWithText("Revised checkpoint").assertDoesNotExist()
    }

    @Test fun tokenOnlyIsStaticAndFactlessCompletionUsesTheOrdinaryStatusRow() {
        val state = mutableStateOf(block("", "tokensAfter" to 0, "estimatedTokensAfter" to 99))
        compose.setContent { HapiTheme { AgentEventBlockView(state.value) } }
        compose.onNodeWithText("0 tokens after", substring = true).assertIsDisplayed()
        compose.onNodeWithText("estimated", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("compaction-header-compact").assertHasNoClickAction()
        compose.onNodeWithTag("compaction-summary-compact").assertDoesNotExist()
        compose.runOnIdle { state.value = block(" \n", "tokensBefore" to -1, "tokensAfter" to 1.5) }
        compose.onNodeWithText("📦 Context compacted").assertIsDisplayed().assertHasNoClickAction()
        compose.onNodeWithTag("compaction-card-compact").assertDoesNotExist()
        compose.runOnIdle { state.value = block("", "tokensBefore" to 100, "estimatedTokensAfter" to 40) }
        compose.onNodeWithText("100 → ~40 tokens (estimated after)", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("compaction-header-compact").assertHasNoClickAction()
    }
}

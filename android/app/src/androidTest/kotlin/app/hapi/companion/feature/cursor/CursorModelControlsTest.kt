package app.hapi.companion.feature.cursor

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.CursorModelSummary
import app.hapi.protocol.wire.CursorModelsResponse
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CursorModelControlsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun changingSpeedPreservesReasoningAndSendsOneAdvertisedId() {
        val id = "grok-4.7[reasoning_effort=high,fast=false]"
        val fast = id.replace("false", "true")
        val response = CursorModelsResponse(true, listOf(id, fast, id.replace("high", "low"), fast.replace("high", "low")).map { CursorModelSummary(it) })
        val selected = mutableStateOf(id)
        val changes = mutableListOf<String>()
        compose.setContent {
            HapiTheme {
                Column {
                    CursorModelControls(response, selected.value, enabled = true) {
                        selected.value = it
                        changes.add(it)
                    }
                }
            }
        }
        compose.onNodeWithText("Standard").performClick()
        compose.onNodeWithText("Fast", useUnmergedTree = true).performClick()
        compose.onNodeWithText("high").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(fast), changes) }
    }
}

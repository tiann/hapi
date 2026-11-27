package app.hapi.companion.feature.cursor

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.hapi.companion.feature.chat.SessionConfigSheet
import app.hapi.companion.feature.chat.SessionConfigUi
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.CursorModelSummary
import app.hapi.protocol.wire.CursorModelsResponse
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class CursorModelControlsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun loadingAndLoadedCatalogDoNotReopenTheNetworkRequest() {
        val wire = "grok[fast=false]"
        val eligible = SessionConfigUi(
            flavor = "cursor", active = true, controlledByUser = false,
            permissionMode = "default", permissionModes = emptyList(),
            model = wire, modelOptions = emptyList(), modelOptionsLoading = false,
            effort = null, effortOptions = null,
        )
        val config = mutableStateOf(eligible)
        val visible = mutableStateOf(true)
        var loads = 0
        compose.setContent {
            if (visible.value) HapiTheme {
                SessionConfigSheet(config.value, contextUsage = null, onDismiss = {},
                    onSetPermissionMode = {}, onSetModel = {}, onSetEffort = {}, onLoadModelOptions = { loads++ })
            }
        }
        compose.runOnIdle { assertEquals(1, loads); config.value = eligible.copy(modelOptionsLoading = true) }
        compose.runOnIdle {
            config.value = eligible.copy(
                modelOptions = null, cursorCatalog = CursorModelsResponse(true, listOf(CursorModelSummary(wire))),
            )
        }
        compose.runOnIdle { assertEquals(1, loads); visible.value = false }
        compose.runOnIdle { visible.value = true }
        compose.runOnIdle { assertEquals(2, loads) }
    }

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

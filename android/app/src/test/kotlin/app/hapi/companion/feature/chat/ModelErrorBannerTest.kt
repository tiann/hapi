package app.hapi.companion.feature.chat

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.hapi.companion.feature.sessions.SessionRow
import app.hapi.companion.feature.sessions.SessionRowUi
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.ModelError
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en")
class ModelErrorBannerTest {
    @get:Rule val compose = createComposeRule()

    private val event = ModelError(
        eventId = "first", kind = "timeout", transient = true,
        rawSnippet = "Provider timed out", atTs = 100, priorAssistantClaimsDone = true,
    )

    @Test fun actionsCarryVisibleEventAndShowActualFailureOrReadback() {
        val current = mutableStateOf(event)
        val idle = mutableStateOf(true)
        val busy = mutableStateOf(false)
        val settling = mutableStateOf(false)
        val reason = mutableStateOf<String?>(null)
        val actions = mutableListOf<String>()
        compose.setContent {
            HapiTheme {
                ModelErrorBanner(
                    error = current.value, canBridge = idle.value, busy = busy.value, bridging = settling.value,
                    failureReason = reason.value,
                    onBridge = { actions += "bridge:$it"; busy.value = true },
                    onDismiss = { actions += "ack:$it"; busy.value = true },
                )
            }
        }
        compose.onNodeWithText("Details").performClick()
        compose.onNodeWithText(event.rawSnippet).assertExists()
        compose.onNodeWithText("Bridge & retry").performClick().assertIsNotEnabled()
        compose.onNodeWithText("Dismiss").assertIsNotEnabled()
        compose.runOnIdle { busy.value = false; reason.value = "prompt_in_flight" }
        compose.onNodeWithText("A turn is already running.").assertExists()
        compose.runOnIdle { reason.value = "runner_busy" }
        compose.onNodeWithText("runner_busy").assertExists()
        compose.runOnIdle { reason.value = null; settling.value = true; idle.value = false }
        compose.onNodeWithText("Bridging…").assertIsNotEnabled()
        compose.onNodeWithText("Dismiss").assertIsEnabled()
        compose.onNodeWithText("Last message resent", substring = true).assertDoesNotExist()
        compose.runOnIdle { current.value = event.copy(bridgedForEventId = event.eventId); settling.value = false }
        compose.onNodeWithText("Last message resent · timeout").assertExists()
        compose.onNodeWithText("Bridge & retry").assertDoesNotExist()
        compose.runOnIdle { current.value = event.copy(eventId = "second", retriedAndFailed = true) }
        compose.onNodeWithText(event.rawSnippet).assertDoesNotExist()
        compose.onNodeWithText("Retry failed · timeout").assertExists()
        compose.onNodeWithText("Dismiss").performClick()
        compose.runOnIdle { current.value = current.value.copy(acknowledgedAt = 103) }
        compose.onNodeWithText("Dismiss").assertDoesNotExist()
        assertEquals(listOf("bridge:first", "ack:second"), actions)
    }

    @Test fun retryHiddenWhenIneligibleButAcknowledgementAvailable() {
        val current = mutableStateOf(event)
        val canBridge = mutableStateOf(false)
        compose.setContent {
            HapiTheme { ModelErrorBanner(current.value, canBridge.value, false, false, null, {}, {}) }
        }
        compose.onNodeWithText("Bridge & retry").assertDoesNotExist()
        for (ineligible in listOf(
            event.copy(bridgeable = false), event.copy(transient = false),
            event.copy(supersededByUserTurn = true), event.copy(retriedAndFailed = true),
        )) {
            compose.runOnIdle { current.value = ineligible; canBridge.value = true }
            compose.onNodeWithText("Bridge & retry").assertDoesNotExist()
            compose.onNodeWithText("Dismiss").assertIsEnabled()
        }
    }

    @Test fun listRowSurfacesOnlyUnrecoveredAndFailedErrorsEvenWhenInactive() {
        val current = mutableStateOf(event)
        compose.setContent {
            HapiTheme {
                SessionRow(
                    SessionRowUi(
                        summary = SessionSummary(
                            id = "id", active = false,
                            metadata = SessionSummaryMetadata(path = "/repo", lastModelError = current.value),
                        ),
                        title = "Session", subtitle = null, meta = null, flavor = "cursor", unread = true,
                    ),
                    onOpen = {}, onLongPress = {},
                )
            }
        }
        compose.onNodeWithText("Model error · timeout", useUnmergedTree = true).assertExists()
        compose.runOnIdle { current.value = event.copy(bridgedForEventId = event.eventId) }
        compose.onNodeWithText("Model error · timeout", useUnmergedTree = true).assertDoesNotExist()
        compose.runOnIdle { current.value = current.value.copy(retriedAndFailed = true) }
        compose.onNodeWithText("Retry failed · timeout", useUnmergedTree = true).assertExists()
        compose.runOnIdle { current.value = current.value.copy(acknowledgedAt = 105) }
        compose.onNodeWithText("Retry failed · timeout", useUnmergedTree = true).assertDoesNotExist()
    }
}

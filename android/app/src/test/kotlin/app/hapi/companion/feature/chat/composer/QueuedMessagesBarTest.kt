package app.hapi.companion.feature.chat.composer

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.requestFocus
import app.hapi.companion.feature.chat.QueuedRowUi
import app.hapi.companion.ui.theme.HapiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalTestApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w412dp-h915dp-xxhdpi")
class QueuedMessagesBarTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun editableRowAcceptsKeyboardActivation() {
        var edits = 0
        compose.setContent {
            HapiTheme {
                QueuedMessagesBar(
                    rows = listOf(
                        QueuedRowUi(
                            id = "editable",
                            localId = "local",
                            text = "Editable queued message",
                            attachmentNames = emptyList(),
                            scheduledAt = null,
                            canAct = true,
                            canSteer = false,
                        ),
                    ),
                    onSteer = {},
                    onRetry = {},
                    onEdit = { edits += 1 },
                    onCancel = {},
                )
            }
        }

        val row = compose.onNodeWithTag("chat-queued-row-editable")
        row.requestFocus()
        row.performKeyInput { pressKey(Key.Enter) }
        row.performKeyInput { pressKey(Key.Spacebar) }

        compose.runOnIdle { assertEquals(2, edits) }
    }

    @Test
    fun scheduledAttachmentRowKeepsMenuAndCancelButDoesNotOfferEdit() {
        var edits = 0
        var cancels = 0
        compose.setContent {
            HapiTheme {
                QueuedMessagesBar(
                    rows = listOf(
                        QueuedRowUi(
                            id = "scheduled",
                            localId = "local",
                            text = "Attachment-backed scheduled message",
                            attachmentNames = listOf("notes.txt"),
                            scheduledAt = System.currentTimeMillis() + 60_000,
                            canAct = true,
                            canSteer = false,
                            canEdit = false,
                        ),
                    ),
                    onSteer = {},
                    onRetry = {},
                    onEdit = { edits += 1 },
                    onCancel = { cancels += 1 },
                )
            }
        }

        val row = compose.onNodeWithTag("chat-queued-row-scheduled")
        row.assert(SemanticsMatcher.keyNotDefined(SemanticsActions.OnClick))
        row.performTouchInput { longClick() }

        compose.onNodeWithText("Edit").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Cancel").assertIsEnabled().performClick()

        compose.runOnIdle {
            assertEquals(0, edits)
            assertEquals(1, cancels)
        }
    }
}

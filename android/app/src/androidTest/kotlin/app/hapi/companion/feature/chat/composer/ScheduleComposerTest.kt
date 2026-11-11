package app.hapi.companion.feature.chat.composer

import androidx.compose.material3.Surface
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentUi
import app.hapi.companion.ui.theme.HapiTheme
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * Instrumented state-transition coverage for the schedule picker (B-M16b,
 * PR review asks): the schedule×attachment mutual exclusion at the composer
 * surface (panel dismissed when a chip lands, clock disabled) and the
 * digit-IME entry of the Specific `YYYY-MM-DD` / `HH:mm` fields through the
 * real text-input pipeline ([androidx.compose.ui.test.performTextInput]
 * injects through the IME channel, so the masks are exercised the way the
 * soft keyboard drives them).
 *
 * Budget: the composer alone (no transcript) fits the CI AVD's 320×640
 * viewport; each test mounts exactly one [androidx.compose.ui.test.junit4
 * .createComposeRule.setContent].
 */
class ScheduleComposerTest {
    @get:Rule val compose = createComposeRule()

    private fun shotChip(id: String = "att-1") = ComposerAttachmentUi(
        id = id,
        filename = "shot.jpg",
        mimeType = "image/jpeg",
        sizeBytes = 3,
        previewBytes = null,
        status = ComposerAttachmentStatus.Ready,
    )

    private fun mountComposer(
        attachments: MutableState<List<ComposerAttachmentUi>>,
        onSchedule: (PendingSchedule) -> Unit,
    ) {
        compose.setContent {
            HapiTheme {
                Surface {
                    ChatComposer(
                        state = ComposerUiState(text = "", isSending = false, canSteer = false),
                        onTextChange = { _, _, _ -> },
                        onSend = {},
                        onSendSteer = {},
                        onAbort = {},
                        attachments = attachments.value,
                        onAddAttachment = {},
                        pendingSchedule = null,
                        onScheduleSelected = onSchedule,
                        onClearSchedule = {},
                    )
                }
            }
        }
    }

    private fun openPicker() {
        // With the tray empty only the clock button carries this description
        // (the panel's own semantics node exists just after the tap).
        compose.onNodeWithContentDescription("Schedule send").performClick()
    }

    @Test
    fun openPickerDismissesWhenAnAttachmentLandsAndTheClockDisables() {
        val attachments = mutableStateOf(listOf<ComposerAttachmentUi>())
        mountComposer(attachments, onSchedule = {})

        openPicker()
        compose.onNodeWithText("Relative").assertIsDisplayed()

        // "+ → pick a file" while the panel is open: the still-interactive
        // panel must dismiss the moment the chip appears (every pick in it
        // would arm the illegal schedule+attachments combo), and the clock
        // entry point disables with the non-empty tray.
        compose.runOnIdle { attachments.value = listOf(shotChip()) }
        compose.onNodeWithText("Relative").assertDoesNotExist()
        compose.onNodeWithContentDescription("Schedule send").assertIsNotEnabled()
    }

    @Test
    fun presetTapDeliversThePickAndClosesThePanel() {
        val picked = mutableListOf<PendingSchedule>()
        mountComposer(mutableStateOf(emptyList()), onSchedule = { picked += it })

        openPicker()
        compose.onNodeWithText("+30m").performClick()

        assertEquals(listOf(PendingSchedule.Preset("+30m")), picked)
        compose.onNodeWithText("Relative").assertDoesNotExist()
    }

    @Test
    fun specificFieldsFormatTypedDigitsIntoTheRequiredSeparators() {
        val picked = mutableListOf<PendingSchedule>()
        mountComposer(mutableStateOf(emptyList()), onSchedule = { picked += it })

        openPicker()
        compose.onNodeWithText("Specific").performClick()

        // A digit-only IME (Gboard's number pad has no `-` or `:` key) types
        // the raw digits; the masks must grow the separators in live. The
        // click focuses each field first — real IME injection goes to the
        // focused editor, exactly like the soft keyboard.
        val tomorrow = LocalDate.now().plusDays(1)
        compose.onNodeWithTag("schedule-date-input").performClick()
            .performTextInput(tomorrow.toString().replace("-", ""))
        compose.onNodeWithTag("schedule-date-input")
            .assertTextContains(tomorrow.toString(), substring = true)
        compose.onNodeWithTag("schedule-time-input").performClick().performTextInput("1430")
        compose.onNodeWithTag("schedule-time-input").assertTextContains("14:30", substring = true)

        compose.onNodeWithTag("schedule-submit").performClick()
        compose.waitForIdle()
        // The pick resolves to the typed wall time in the device zone —
        // exactly the epoch the parser computed from the masked fields.
        val pick = picked.single()
        assertTrue(pick is PendingSchedule.Absolute)
        assertEquals(
            java.time.ZonedDateTime.of(tomorrow, LocalTime.of(14, 30), ZoneId.systemDefault())
                .toInstant().toEpochMilli(),
            (pick as PendingSchedule.Absolute).ms,
        )
    }

    @Test
    fun partialSpecificInputShowsTheInlineErrorOnSubmit() {
        mountComposer(mutableStateOf(emptyList()), onSchedule = {})

        openPicker()
        compose.onNodeWithText("Specific").performClick()

        // Half-typed shapes are non-blank, so Submit is tappable — the
        // unparseable pair must surface the inline invalid error instead of
        // failing the tap silently.
        compose.onNodeWithTag("schedule-date-input").performClick().performTextInput("20261")
        compose.onNodeWithTag("schedule-date-input").assertTextContains("2026-1", substring = true)
        compose.onNodeWithTag("schedule-time-input").performClick().performTextInput("143")
        compose.onNodeWithTag("schedule-submit").performClick()

        compose.onNodeWithText("Enter the full date and time (YYYY-MM-DD, HH:mm).").assertIsDisplayed()
    }
}

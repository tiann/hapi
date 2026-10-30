package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import java.time.ZoneId

/**
 * The schedule panel (B-M16b, web `ScheduleTimePicker.tsx` twin): Relative /
 * Specific tabs; Relative = the exact web preset set (`+5m/+30m/+1h/+4h`,
 * labels unlocalized like the web) in a 2×2 grid with the active preset
 * highlighted; Specific = date + time fields (the web's single
 * `datetime-local` box, minute resolution, split for touch keyboards) with
 * the 30 s-grace / 7-day validation, error shown red and cleared on edit,
 * Submit disabled while empty — the web's exact submit gating.
 *
 * web 同构/分歧:
 * - 分歧 (placement): the web anchors a fixed panel above the clock button
 *   (bottom sheet on touch viewports); Android renders it above the input
 *   card like the slash/mention dropdowns, the composer's popup precedent.
 * - 分歧 (dismiss): the web closes on outside-pointer-down; Android closes on
 *   the clock-button toggle and on selection, matching the dropdown
 *   precedent. Closing without picking never touches the pending value
 *   (web: "关面板不动已选值").
 * - The web's `min`/`max` input attributes are browser affordances; the real
 *   gate is [ScheduleSend.validateSpecificDatetime], as on the web.
 */
@Composable
internal fun ScheduleTimePicker(
    pendingSchedule: PendingSchedule?,
    onSchedule: (PendingSchedule) -> Unit,
    modifier: Modifier = Modifier,
    /** Injectable clock for previews; validation runs on submit, like the web. */
    now: () -> Long = System::currentTimeMillis,
) {
    var tab by remember { mutableStateOf(SchedulePickerTab.Relative) }
    var dateText by remember { mutableStateOf("") }
    var timeText by remember { mutableStateOf("") }
    var specificError by remember { mutableStateOf<ScheduleSend.SpecificError?>(null) }
    val dialogDescription = stringResource(R.string.chat_schedule_send)

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 2.dp,
        modifier = modifier
            .fillMaxWidth()
            .semantics { contentDescription = dialogDescription },
    ) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(R.string.chat_schedule_send),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PickerTab(
                    label = stringResource(R.string.chat_schedule_relative_tab),
                    selected = tab == SchedulePickerTab.Relative,
                    onClick = { tab = SchedulePickerTab.Relative },
                    modifier = Modifier.weight(1f),
                )
                PickerTab(
                    label = stringResource(R.string.chat_schedule_specific_tab),
                    selected = tab == SchedulePickerTab.Specific,
                    onClick = { tab = SchedulePickerTab.Specific },
                    modifier = Modifier.weight(1f),
                )
            }
            when (tab) {
                // The 2×2 preset grid as two rows of two (web `grid
                // grid-cols-2`); cell order follows [ScheduleSend.PRESETS].
                SchedulePickerTab.Relative -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PresetCell(
                            preset = ScheduleSend.PRESETS[0],
                            pendingSchedule = pendingSchedule,
                            onSchedule = onSchedule,
                            modifier = Modifier.weight(1f),
                        )
                        PresetCell(
                            preset = ScheduleSend.PRESETS[1],
                            pendingSchedule = pendingSchedule,
                            onSchedule = onSchedule,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PresetCell(
                            preset = ScheduleSend.PRESETS[2],
                            pendingSchedule = pendingSchedule,
                            onSchedule = onSchedule,
                            modifier = Modifier.weight(1f),
                        )
                        PresetCell(
                            preset = ScheduleSend.PRESETS[3],
                            pendingSchedule = pendingSchedule,
                            onSchedule = onSchedule,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                SchedulePickerTab.Specific -> SpecificPicker(
                    dateText = dateText,
                    timeText = timeText,
                    error = specificError,
                    onDateChange = {
                        dateText = it
                        specificError = null
                    },
                    onTimeChange = {
                        timeText = it
                        specificError = null
                    },
                    onSubmit = {
                        val parsed = ScheduleSend.parseSpecificInput(dateText, timeText, ZoneId.systemDefault())
                            ?: return@SpecificPicker
                        val error = ScheduleSend.validateSpecificDatetime(parsed, now())
                        if (error != null) {
                            specificError = error
                        } else {
                            onSchedule(PendingSchedule.Absolute(parsed))
                        }
                    },
                )
            }
        }
    }
}

private enum class SchedulePickerTab { Relative, Specific }

/** One half-width tab pill; the selected one gets the filled background. */
@Composable
private fun PickerTab(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.surfaceContainerHighest
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (selected) {
            MaterialTheme.colorScheme.onSurface
        } else {
            MaterialTheme.hapi.hint
        },
        shape = RoundedCornerShape(8.dp),
        onClick = onClick,
        modifier = modifier,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(vertical = 6.dp),
        )
    }
}

/** One preset cell; the active preset renders accent-filled (web blue → primary). */
@Composable
private fun PresetCell(
    preset: String,
    pendingSchedule: PendingSchedule?,
    onSchedule: (PendingSchedule) -> Unit,
    modifier: Modifier = Modifier,
) {
    val selected = pendingSchedule is PendingSchedule.Preset && pendingSchedule.preset == preset
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (selected) {
            MaterialTheme.colorScheme.onPrimary
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        shape = RoundedCornerShape(10.dp),
        border = if (selected) null else BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
        onClick = { onSchedule(PendingSchedule.Preset(preset)) },
        modifier = modifier,
    ) {
        Text(
            text = preset,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(vertical = 10.dp),
        )
    }
}

/** The Specific tab: date + time entry, error/hint line, full-width Submit. */
@Composable
private fun SpecificPicker(
    dateText: String,
    timeText: String,
    error: ScheduleSend.SpecificError?,
    onDateChange: (String) -> Unit,
    onTimeChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            // Format hints, not prose — kept unlocalized like the web's
            // datetime-local pattern (YYYY-MM-DDTHH:mm).
            OutlinedTextField(
                value = dateText,
                onValueChange = onDateChange,
                modifier = Modifier.weight(1.4f),
                singleLine = true,
                placeholder = { Text("YYYY-MM-DD") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            OutlinedTextField(
                value = timeText,
                onValueChange = onTimeChange,
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text("HH:mm") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
        }
        Text(
            text = when (error) {
                ScheduleSend.SpecificError.Past -> stringResource(R.string.chat_schedule_error_past)
                ScheduleSend.SpecificError.TooFar -> stringResource(R.string.chat_schedule_error_too_far)
                null -> stringResource(R.string.chat_schedule_specific_hint)
            },
            style = MaterialTheme.typography.labelSmall,
            color = if (error != null) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.hapi.hint
            },
        )
        Button(
            onClick = onSubmit,
            enabled = dateText.isNotBlank() && timeText.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.chat_schedule_send))
        }
    }
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun ScheduleTimePickerPreview() {
    HapiTheme {
        Surface {
            ScheduleTimePicker(
                pendingSchedule = PendingSchedule.Preset("+30m"),
                onSchedule = {},
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ScheduleTimePickerAbsolutePreview() {
    HapiTheme {
        Surface {
            ScheduleTimePicker(
                pendingSchedule = PendingSchedule.Absolute(1_761_000_000_000),
                onSchedule = {},
            )
        }
    }
}

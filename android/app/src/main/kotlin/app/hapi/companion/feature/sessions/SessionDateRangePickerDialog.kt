package app.hapi.companion.feature.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.hapi.companion.R
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale as JavaLocale

/** M3 `DateRangePicker` counts dates as UTC midnights; epoch day is exactly that unit. */
private const val MILLIS_PER_DAY = 86_400_000L

/** How many of the most recent active days the lightweight legend shows. */
private const val LEGEND_DAY_CAP = 10

/**
 * Activity date-range picker dialog — Android shape of the web
 * `SessionDateRangePicker` (`SessionList.tsx`).
 *
 * Parity: pick a start and an end day (M3 keeps `start <= end` itself, the
 * web picker sorts the two clicks); the filter window is
 * `[start local midnight, end local midnight + 1 day)`; opening on the
 * selected start's month, else the current month; a `Clear` action while
 * anything is selected; nothing is persisted (the selection lives in the
 * ViewModel as transient state, like the web's `useState`).
 *
 * Declared divergence: M3 `DateRangePicker` has no public per-day decoration
 * API, so the web's in-cell "has session activity" text emphasis cannot be
 * reproduced inside the calendar. The activity days surface as a lightweight
 * legend row under the picker instead ([ActivityDayLegend]). The M3 dialog
 * also applies via an explicit `Apply` button rather than the web's
 * close-after-second-click.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionDateRangePickerDialog(
    current: SessionDateRange?,
    activityEpochDays: Set<Long>,
    onApply: (startEpochDay: Long, endEpochDay: Long) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    // Web parity: open on the selected start's month, otherwise the current month.
    val initialMonthEpochDay = current?.startEpochDay ?: LocalDate.now(ZoneId.systemDefault()).toEpochDay()
    val pickerState = rememberDateRangePickerState(
        initialSelectedStartDateMillis = current?.startEpochDay?.times(MILLIS_PER_DAY),
        initialSelectedEndDateMillis = current?.endEpochDay?.times(MILLIS_PER_DAY),
        initialDisplayedMonthMillis = initialMonthEpochDay * MILLIS_PER_DAY,
    )
    val hasSelection = pickerState.selectedStartDateMillis != null

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            shape = MaterialTheme.shapes.extraLarge,
            tonalElevation = 6.dp,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 640.dp),
        ) {
            Column {
                DateRangePicker(
                    state = pickerState,
                    title = {
                        Text(
                            text = stringResource(R.string.sessions_time_filter_label),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    showModeToggle = false,
                    modifier = Modifier.weight(1f),
                )
                ActivityDayLegend(activityEpochDays)
                HorizontalDivider()
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(end = 8.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Web footer `Clear`: resets the in-progress selection and the
                    // active filter without closing the picker.
                    TextButton(
                        onClick = {
                            pickerState.setSelection(null, null)
                            onClear()
                        },
                        enabled = hasSelection || current != null,
                    ) {
                        Text(stringResource(R.string.sessions_time_filter_clear))
                    }
                    TextButton(onClick = onDismiss) {
                        Text(stringResource(R.string.home_cancel))
                    }
                    TextButton(
                        onClick = {
                            val start = pickerState.selectedStartDateMillis ?: return@TextButton
                            val end = pickerState.selectedEndDateMillis ?: return@TextButton
                            onApply(start / MILLIS_PER_DAY, end / MILLIS_PER_DAY)
                        },
                        enabled = pickerState.selectedStartDateMillis != null &&
                            pickerState.selectedEndDateMillis != null,
                    ) {
                        Text(stringResource(R.string.sessions_time_filter_apply))
                    }
                }
            }
        }
    }
}

/**
 * Lightweight activity marking next to the picker (declared divergence, see
 * [SessionDateRangePickerDialog]): the most recent days with session
 * activity, derived before any list filtering — mirroring the web
 * `sessionActivityDates` set that keeps marking days while a filter is
 * active. Hidden when there is no activity at all.
 */
@Composable
private fun ActivityDayLegend(activityEpochDays: Set<Long>) {
    if (activityEpochDays.isEmpty()) return
    val recentDays = activityEpochDays.sortedDescending().take(LEGEND_DAY_CAP)
    val formatter = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(JavaLocale.getDefault())
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.sessions_time_filter_recent_activity),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        LazyRow(
            modifier = Modifier
                .weight(1f)
                .padding(start = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(recentDays) { epochDay ->
                Surface(
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Text(
                        text = LocalDate.ofEpochDay(epochDay).format(formatter),
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 1,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
        }
    }
}

/** Locale-aware day label for the filter sheet (machine `YYYY-MM-DD` stays in [SessionDateRangeFilter]). */
internal fun formatEpochDayLocalized(epochDay: Long): String =
    LocalDate.ofEpochDay(epochDay)
        .format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(JavaLocale.getDefault()))

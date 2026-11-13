package app.hapi.companion.feature.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.wire.SessionListSort
import kotlinx.coroutines.launch

@Composable
internal fun machineFilterLabel(filter: MachineFilterUi): String = when {
    filter.id == UNKNOWN_MACHINE_ID -> stringResource(R.string.sessions_filter_unknown_machine)
    filter.unnamed -> stringResource(R.string.sessions_machine_fallback, filter.label)
    else -> filter.label
}

/**
 * One compact sheet for every list view choice (web "Sort and filter", iOS
 * filter menu): each multi-way choice is a single "label … value ▾" row that
 * opens a menu, booleans are switches, so the whole sheet fits without
 * scrolling. Filters (machine, dates, status, unread) are transient; sort and
 * Active first persist. Choices apply immediately; Reset clears filters only.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionFilterSheet(
    state: SessionListUiState,
    onSelectSort: (SessionListSort) -> Unit,
    onSetActiveFirst: (Boolean) -> Unit,
    onSelectStatus: (SessionListStatus) -> Unit,
    onSetUnreadOnly: (Boolean) -> Unit,
    onSelectMachine: (String?) -> Unit,
    onOpenDates: () -> Unit,
    onClearDates: () -> Unit,
    onReset: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.sessions_filters),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onReset, enabled = state.hasActiveFilters) {
                Text(stringResource(R.string.sessions_filters_reset))
            }
            TextButton(onClick = { scope.launch { sheetState.hide(); onDismiss() } }) {
                Text(stringResource(R.string.sessions_filters_done))
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 16.dp).testTag("session-filters"),
        ) {
            item("filter-title") { SectionTitle(stringResource(R.string.sessions_filter_section)) }
            if (state.hasMachineFilters) {
                item("machines") {
                    val selected = state.machineFilters.firstOrNull { it.id == state.activeMachineFilter }
                    ChoiceRow(
                        label = stringResource(R.string.sessions_filter_machines),
                        value = selected?.let { machineFilterLabel(it) } ?: stringResource(R.string.sessions_filter_all),
                        tag = "session-machine-filter",
                    ) { close ->
                        MenuChoice(stringResource(R.string.sessions_filter_all), selected == null) {
                            close(); onSelectMachine(null)
                        }
                        HorizontalDivider()
                        state.machineFilters.forEach { filter ->
                            MenuChoice(
                                machineFilterLabel(filter), filter.id == state.activeMachineFilter,
                                trailing = filter.sessionCount.toString(),
                            ) { close(); onSelectMachine(filter.id) }
                        }
                    }
                }
            }
            item("dates") {
                val range = state.dateRange
                SettingRow(
                    label = stringResource(R.string.sessions_filter_dates),
                    onClick = {
                        // Finish the sheet transition before opening another window.
                        scope.launch {
                            sheetState.hide()
                            onOpenDates()
                        }
                    },
                    tag = "session-date-filter",
                ) {
                    ValueText(
                        if (range == null) stringResource(R.string.sessions_filter_any_date)
                        else stringResource(
                            R.string.sessions_time_filter_summary,
                            formatEpochDayLocalized(range.startEpochDay),
                            formatEpochDayLocalized(range.endEpochDay),
                        ),
                        active = range != null,
                    )
                    if (range != null) {
                        IconButton(onClick = onClearDates, modifier = Modifier.size(40.dp)) {
                            Icon(
                                painterResource(R.drawable.ic_sym_close),
                                stringResource(R.string.sessions_filter_clear_dates),
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    } else {
                        Chevron(opensDialog = true)
                    }
                }
            }
            item("status") {
                val statusLabel = statusLabel(state.statusFilter)
                ChoiceRow(stringResource(R.string.sessions_view_status), statusLabel, "session-status-filter") { close ->
                    SessionListStatus.entries.forEach { status ->
                        MenuChoice(statusLabel(status), status == state.statusFilter) { close(); onSelectStatus(status) }
                    }
                }
            }
            item("unread-only") {
                SwitchOption(stringResource(R.string.sessions_view_unread_only), state.unreadOnly, onSetUnreadOnly, "session-unread-only")
            }
            item("sort-title") { SectionTitle(stringResource(R.string.sessions_sort_section)) }
            item("sort") {
                val sortLabel = sortLabel(state.order.sort)
                ChoiceRow(stringResource(R.string.sessions_view_sort), sortLabel, "session-sort") { close ->
                    SessionListSort.entries.forEach { sort ->
                        MenuChoice(sortLabel(sort), sort == state.order.sort) { close(); onSelectSort(sort) }
                    }
                }
            }
            item("active-first") {
                SwitchOption(stringResource(R.string.sessions_view_active_first), state.order.activeFirst, onSetActiveFirst, "session-active-first")
            }
        }
    }
}

@Composable
private fun statusLabel(status: SessionListStatus): String = stringResource(
    when (status) {
        SessionListStatus.All -> R.string.sessions_view_status_all
        SessionListStatus.Active -> R.string.sessions_view_status_active
        SessionListStatus.Archived -> R.string.sessions_view_status_archived
    },
)

@Composable
private fun sortLabel(sort: SessionListSort): String = stringResource(
    when (sort) {
        SessionListSort.LastMessage -> R.string.sessions_view_sort_last_message
        SessionListSort.Created -> R.string.sessions_view_sort_created
    },
)

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.hapi.textSecondary,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 4.dp),
    )
}

/** One 56dp row: label on the left, [trailing] (value, chevron, switch) on the right. */
@Composable
private fun SettingRow(
    label: String,
    onClick: () -> Unit,
    tag: String,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 56.dp).padding(start = 24.dp, end = 16.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f).padding(end = 16.dp))
        trailing()
    }
}

@Composable
private fun ValueText(text: String, active: Boolean = false) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.hapi.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.End,
        modifier = Modifier.widthIn(max = 200.dp),
    )
}

@Composable
private fun Chevron(expanded: Boolean = false, opensDialog: Boolean = false) {
    Icon(
        painterResource(if (opensDialog) R.drawable.ic_sym_chevron_right else R.drawable.ic_sym_expand_more),
        contentDescription = null,
        tint = MaterialTheme.hapi.textSecondary,
        modifier = Modifier.padding(start = 4.dp).size(20.dp).rotate(if (expanded) 180f else 0f),
    )
}

/** A [SettingRow] whose value opens an anchored menu of [options]; pass `close` before acting. */
@Composable
private fun ChoiceRow(
    label: String,
    value: String,
    tag: String,
    options: @Composable ColumnScope.(close: () -> Unit) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        SettingRow(label, onClick = { open = true }, tag = tag) {
            ValueText(value)
            Chevron(open)
        }
        // Anchored under the row's trailing edge, where the value sits.
        Box(Modifier.align(Alignment.BottomEnd).padding(end = 16.dp)) {
            DropdownMenu(
                expanded = open,
                onDismissRequest = { open = false },
                shape = RoundedCornerShape(12.dp),
            ) { options { open = false } }
        }
    }
}

@Composable
private fun MenuChoice(label: String, selected: Boolean, trailing: String? = null, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        onClick = onClick,
        leadingIcon = {
            Box(Modifier.size(20.dp)) {
                if (selected) Icon(painterResource(R.drawable.ic_sym_check), contentDescription = null, modifier = Modifier.size(20.dp))
            }
        },
        trailingIcon = trailing?.let {
            { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.hapi.textSecondary) }
        },
        modifier = Modifier
            .widthIn(min = 200.dp)
            .semantics { this.selected = selected },
    )
}

@Composable
private fun SwitchOption(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, tag: String) {
    Row(
        Modifier.fillMaxWidth().toggleable(checked, role = Role.Switch, onValueChange = onCheckedChange)
            .heightIn(min = 56.dp).padding(start = 24.dp, end = 16.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null)
    }
}

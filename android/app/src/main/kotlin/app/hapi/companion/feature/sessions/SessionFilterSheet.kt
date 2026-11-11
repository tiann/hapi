package app.hapi.companion.feature.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.SessionListSort
import kotlinx.coroutines.launch

@Composable
internal fun machineFilterLabel(filter: MachineFilterUi): String = when {
    filter.id == UNKNOWN_MACHINE_ID -> stringResource(R.string.sessions_filter_unknown_machine)
    filter.unnamed -> stringResource(R.string.sessions_machine_fallback, filter.label)
    else -> filter.label
}

/**
 * One sheet for every list view choice (web "Sort and filter"): the machine /
 * date / status / unread filters (transient), then sort key and Active first
 * (persisted). Choices apply immediately; Reset clears filters only.
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
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp),
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
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f, fill = false).heightIn(max = 480.dp)
                .testTag("session-filters"),
        ) {
            if (state.hasMachineFilters) {
                item("machines-title") {
                    Text(
                        stringResource(R.string.sessions_filter_machines),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                item("machines") {
                    Column(Modifier.selectableGroup()) {
                        FilterOption(stringResource(R.string.sessions_filter_all), state.activeMachineFilter == null) { onSelectMachine(null) }
                        state.machineFilters.forEach { filter ->
                            FilterOption("${machineFilterLabel(filter)} · ${filter.sessionCount}", state.activeMachineFilter == filter.id) {
                                onSelectMachine(filter.id)
                            }
                        }
                    }
                }
                item("divider") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            }
            item("dates") {
                val range = state.dateRange
                ListItem(
                    headlineContent = { Text(stringResource(R.string.sessions_filter_dates)) },
                    supportingContent = {
                        Text(
                            if (range == null) stringResource(R.string.sessions_filter_any_date)
                            else stringResource(
                                R.string.sessions_time_filter_summary,
                                formatEpochDayLocalized(range.startEpochDay),
                                formatEpochDayLocalized(range.endEpochDay),
                            ),
                        )
                    },
                    leadingContent = { Icon(painterResource(R.drawable.ic_calendar), contentDescription = null) },
                    trailingContent = {
                        if (range != null) {
                            IconButton(onClick = onClearDates, modifier = Modifier.size(48.dp)) {
                                Icon(Icons.Default.Close, stringResource(R.string.sessions_filter_clear_dates))
                            }
                        }
                    },
                    modifier = Modifier.clickable {
                        // Finish the sheet transition before opening another window.
                        scope.launch {
                            sheetState.hide()
                            onOpenDates()
                        }
                    }.testTag("session-date-filter"),
                )
            }
            // Filters first (machines and dates keep their place), then the
            // rarely changed ordering at the bottom.
            item("status-divider") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item("status-title") { SectionTitle(stringResource(R.string.sessions_view_status)) }
            item("status") {
                Column(Modifier.selectableGroup()) {
                    FilterOption(stringResource(R.string.sessions_view_status_all), state.statusFilter == SessionListStatus.All) {
                        onSelectStatus(SessionListStatus.All)
                    }
                    FilterOption(stringResource(R.string.sessions_view_status_active), state.statusFilter == SessionListStatus.Active) {
                        onSelectStatus(SessionListStatus.Active)
                    }
                    FilterOption(stringResource(R.string.sessions_view_status_archived), state.statusFilter == SessionListStatus.Archived) {
                        onSelectStatus(SessionListStatus.Archived)
                    }
                }
            }
            item("unread-only") {
                SwitchOption(stringResource(R.string.sessions_view_unread_only), state.unreadOnly, onSetUnreadOnly, "session-unread-only")
            }
            item("sort-divider") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
            item("sort-title") { SectionTitle(stringResource(R.string.sessions_view_sort)) }
            item("sort") {
                Column(Modifier.selectableGroup()) {
                    FilterOption(stringResource(R.string.sessions_view_sort_last_message), state.order.sort == SessionListSort.LastMessage) {
                        onSelectSort(SessionListSort.LastMessage)
                    }
                    FilterOption(stringResource(R.string.sessions_view_sort_created), state.order.sort == SessionListSort.Created) {
                        onSelectSort(SessionListSort.Created)
                    }
                }
            }
            item("active-first") {
                SwitchOption(stringResource(R.string.sessions_view_active_first), state.order.activeFirst, onSetActiveFirst, "session-active-first")
            }
        }
        Button(
            onClick = { scope.launch { sheetState.hide(); onDismiss() } },
            modifier = Modifier.fillMaxWidth().padding(16.dp),
        ) {
            Text(stringResource(R.string.sessions_filters_done))
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun SwitchOption(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, tag: String) {
    Row(
        Modifier.fillMaxWidth().toggleable(checked, role = Role.Switch, onValueChange = onCheckedChange)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = null)
    }
}

@Composable
private fun FilterOption(label: String, selected: Boolean, select: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = select)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}

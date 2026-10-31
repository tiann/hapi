package app.hapi.companion.feature.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
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
import kotlinx.coroutines.launch

@Composable
internal fun machineFilterLabel(filter: MachineFilterUi): String = when {
    filter.id == UNKNOWN_MACHINE_ID -> stringResource(R.string.sessions_filter_unknown_machine)
    filter.unnamed -> stringResource(R.string.sessions_machine_fallback, filter.label)
    else -> filter.label
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionFilterSheet(
    state: SessionListUiState,
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
                .selectableGroup().testTag("session-filters"),
        ) {
            if (state.hasMachineFilters) {
                item("machines-title") {
                    Text(
                        stringResource(R.string.sessions_filter_machines),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                item("all") {
                    FilterOption(
                        label = stringResource(R.string.sessions_filter_all),
                        selected = state.activeMachineFilter == null,
                        select = { onSelectMachine(null) },
                    )
                }
                items(state.machineFilters, key = { "machine:${it.id}" }) { filter ->
                    FilterOption(
                        label = "${machineFilterLabel(filter)} · ${filter.sessionCount}",
                        selected = state.activeMachineFilter == filter.id,
                        select = { onSelectMachine(filter.id) },
                        // Web keeps CPU/RAM in a desktop-only hover tooltip; the
                        // sheet row carries it as a secondary line, tone-colored.
                        health = filter.health,
                    )
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
private fun FilterOption(
    label: String,
    selected: Boolean,
    select: () -> Unit,
    health: MachineHealthUi.Presentation? = null,
) {
    Row(
        Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = select)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Column(Modifier.padding(start = 12.dp)) {
            Text(label)
            health?.let {
                Text(
                    text = it.label,
                    style = MaterialTheme.typography.bodySmall,
                    color = healthToneColor(it.tone),
                )
            }
        }
    }
}

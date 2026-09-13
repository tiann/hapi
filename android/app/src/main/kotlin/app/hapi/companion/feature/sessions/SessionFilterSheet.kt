package app.hapi.companion.feature.sessions

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

@Composable
internal fun machineFilterLabel(filter: MachineFilterUi): String = when {
    filter.id == UNKNOWN_MACHINE_ID -> stringResource(R.string.sessions_filter_unknown_machine)
    filter.unnamed -> stringResource(R.string.sessions_machine_fallback, filter.label)
    else -> filter.label
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionFilterSheet(state: SessionListUiState, select: (String?) -> Unit, dismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = dismiss) {
        Text(stringResource(R.string.sessions_filters), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(16.dp))
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp).selectableGroup().testTag("session-filters")) {
            item("all") {
                FilterOption(stringResource(R.string.sessions_filter_all), state.activeMachineFilter == null) { select(null) }
            }
            items(state.machineFilters, key = { it.id }) { filter ->
                FilterOption("${machineFilterLabel(filter)} · ${filter.sessionCount}", state.activeMachineFilter == filter.id) { select(filter.id) }
            }
        }
        Spacer(Modifier.height(16.dp))
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

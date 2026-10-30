package app.hapi.companion.feature.home

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionDateRangePickerDialog
import app.hapi.companion.feature.sessions.SessionFilterSheet
import app.hapi.companion.feature.sessions.SessionListScreen
import app.hapi.companion.feature.sessions.SessionListViewModel

private enum class FilterDestination { Closed, Filters, Dates }

/** Session list with a full-width search mode and one consolidated filter sheet. */
@Composable
fun HomeScreen(
    viewModel: SessionListViewModel,
    activeHubUrl: String,
    pairedHubs: List<String>,
    onSwitchHub: (String) -> Unit,
    onPairAnotherHub: () -> Unit,
    onSignOut: () -> Unit,
    onOpenSession: (sessionId: String) -> Unit,
    /** "+" FAB on the session list → new-session form (B-M3d). */
    onNewSession: (() -> Unit)? = null,
    /** Hub menu → settings scaffold (B-M4e). */
    onOpenSettings: (() -> Unit)? = null,
    /** Global connection banner state; null hides the banner (slice C-①). */
    connectionChrome: ConnectionChrome? = null,
    /** Runner version-skew banner state; null hides the banner (slice C-②). */
    runnerSkewChrome: RunnerSkewChrome? = null,
) {
    val state by viewModel.uiState.collectAsState()
    var searchExpanded by rememberSaveable(activeHubUrl) { mutableStateOf(state.searchQuery.isNotEmpty()) }
    var filterDestination by rememberSaveable(activeHubUrl) { mutableStateOf(FilterDestination.Closed) }
    var showSignOutConfirm by rememberSaveable(activeHubUrl) { mutableStateOf(false) }

    Scaffold(
        topBar = {
            HomeTopBar(
                activeHubUrl = activeHubUrl,
                pairedHubs = pairedHubs,
                hasActiveFilters = state.hasActiveFilters,
                searchExpanded = searchExpanded,
                searchQuery = state.searchQuery,
                onOpenSearch = { searchExpanded = true },
                onSearchQueryChange = viewModel::setSearchQuery,
                onCloseSearch = {
                    viewModel.setSearchQuery("")
                    searchExpanded = false
                },
                onOpenFilters = { filterDestination = FilterDestination.Filters },
                onSwitchHub = onSwitchHub,
                onPairAnotherHub = onPairAnotherHub,
                onOpenSettings = onOpenSettings,
                onSignOut = { showSignOutConfirm = true },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            connectionChrome?.let { GlobalConnectionBanner(it) }
            runnerSkewChrome?.let { RunnerSkewBanner(it) }
            SessionListScreen(
                viewModel = viewModel,
                onOpenSession = onOpenSession,
                modifier = Modifier.fillMaxSize(),
                onNewSession = onNewSession,
            )
        }
    }

    if (filterDestination == FilterDestination.Filters) {
        SessionFilterSheet(
            state = state,
            onSelectMachine = viewModel::setMachineFilter,
            onOpenDates = { filterDestination = FilterDestination.Dates },
            onClearDates = viewModel::clearDateRange,
            onReset = viewModel::clearFilters,
            onDismiss = { filterDestination = FilterDestination.Closed },
        )
    }
    if (filterDestination == FilterDestination.Dates) {
        SessionDateRangePickerDialog(
            current = state.dateRange,
            activityEpochDays = state.dateActivityEpochDays,
            onApply = { startEpochDay, endEpochDay ->
                viewModel.setDateRange(startEpochDay, endEpochDay)
                filterDestination = FilterDestination.Filters
            },
            onClear = { viewModel.clearDateRange() },
            onDismiss = { filterDestination = FilterDestination.Filters },
        )
    }
    if (showSignOutConfirm) {
        AlertDialog(
            onDismissRequest = { showSignOutConfirm = false },
            title = { Text(stringResource(R.string.home_sign_out)) },
            text = { Text(stringResource(R.string.home_sign_out_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showSignOutConfirm = false
                        onSignOut()
                    },
                ) {
                    Text(stringResource(R.string.home_sign_out), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { showSignOutConfirm = false }) {
                    Text(stringResource(R.string.home_cancel))
                }
            },
        )
    }
}

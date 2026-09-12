package app.hapi.companion.feature.home

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionFilterSheet
import app.hapi.companion.feature.sessions.SessionListScreen
import app.hapi.companion.feature.sessions.SessionListViewModel

/** Session list with one hub/settings menu, centered title and a filter action. */
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
) {
    val state by viewModel.uiState.collectAsState()
    var showFilters by rememberSaveable(activeHubUrl) { mutableStateOf(false) }
    var showSignOutConfirm by rememberSaveable(activeHubUrl) { mutableStateOf(false) }

    Scaffold(
        topBar = {
            HomeTopBar(
                activeHubUrl = activeHubUrl,
                pairedHubs = pairedHubs,
                hasMachineFilters = state.hasMachineFilters,
                hasActiveFilter = state.activeMachineFilter != null,
                onOpenFilters = { showFilters = true },
                onSwitchHub = onSwitchHub,
                onPairAnotherHub = onPairAnotherHub,
                onOpenSettings = onOpenSettings,
                onSignOut = { showSignOutConfirm = true },
            )
        },
    ) { padding ->
        SessionListScreen(
            viewModel = viewModel,
            onOpenSession = onOpenSession,
            modifier = Modifier.fillMaxSize().padding(padding),
            onNewSession = onNewSession,
        )
    }

    if (showFilters) {
        SessionFilterSheet(state, select = { viewModel.setMachineFilter(it); showFilters = false }, dismiss = { showFilters = false })
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeTopBar(
    activeHubUrl: String,
    pairedHubs: List<String>,
    hasMachineFilters: Boolean,
    hasActiveFilter: Boolean,
    onOpenFilters: () -> Unit,
    onSwitchHub: (String) -> Unit,
    onPairAnotherHub: () -> Unit,
    onOpenSettings: (() -> Unit)?,
    onSignOut: () -> Unit,
) {
    var menuOpen by rememberSaveable(activeHubUrl) { mutableStateOf(false) }
    CenterAlignedTopAppBar(
        title = {
            Text(stringResource(R.string.sessions_section_sessions), maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        navigationIcon = {
            // Anchor the only hub menu to its own icon, not the whole toolbar.
            Box {
                IconButton(onClick = { menuOpen = true }, modifier = Modifier.size(48.dp).semantics { stateDescription = activeHubUrl }) {
                    Icon(painterResource(R.drawable.ic_hubs), stringResource(R.string.home_hub_menu))
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    Text(
                        stringResource(R.string.home_switch_hub),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                    pairedHubs.forEach { hub ->
                        DropdownMenuItem(
                            text = { Text(Uri.parse(hub).authority ?: hub, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                            trailingIcon = { if (hub == activeHubUrl) Icon(Icons.Default.Check, contentDescription = null) },
                            modifier = Modifier.semantics { selected = hub == activeHubUrl },
                            onClick = {
                                menuOpen = false
                                if (hub != activeHubUrl) onSwitchHub(hub)
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.home_pair_another)) },
                        leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                        onClick = { menuOpen = false; onPairAnotherHub() },
                    )
                    HorizontalDivider()
                    if (onOpenSettings != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.home_settings)) },
                            leadingIcon = { Icon(Icons.Default.Settings, contentDescription = null) },
                            onClick = { menuOpen = false; onOpenSettings() },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.home_sign_out), color = MaterialTheme.colorScheme.error) },
                        onClick = { menuOpen = false; onSignOut() },
                    )
                }
            }
        },
        actions = {
            if (hasMachineFilters) {
                val filterState = stringResource(if (hasActiveFilter) R.string.sessions_filters_active else R.string.sessions_filter_all)
                IconButton(onClick = onOpenFilters, modifier = Modifier.size(48.dp).semantics { stateDescription = filterState }) {
                    BadgedBox(badge = { if (hasActiveFilter) Badge() }) {
                        Icon(painterResource(R.drawable.ic_filter_list), stringResource(R.string.sessions_filters))
                    }
                }
            }
        },
    )
}

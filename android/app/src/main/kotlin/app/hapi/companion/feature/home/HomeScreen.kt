package app.hapi.companion.feature.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListScreen
import app.hapi.companion.feature.sessions.SessionListViewModel

/**
 * Home = the session list (B-M2b) under a top bar that keeps the hub chores
 * reachable: overflow menu with hub switcher, pair-another and sign-out
 * (the pre-M2b placeholder screen folded into a menu).
 */
@OptIn(ExperimentalMaterial3Api::class)
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
    /** Overflow menu → settings scaffold (B-M4e). */
    onOpenSettings: (() -> Unit)? = null,
) {
    var menuOpen by rememberSaveable { mutableStateOf(false) }
    var showSwitcher by rememberSaveable { mutableStateOf(false) }
    var showSignOutConfirm by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = stringResource(R.string.app_name),
                            style = MaterialTheme.typography.titleLarge,
                        )
                        Text(
                            text = activeHubUrl,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.home_menu))
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        if (onOpenSettings != null) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.home_settings)) },
                                onClick = {
                                    menuOpen = false
                                    onOpenSettings()
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.home_switch_hub)) },
                            onClick = {
                                menuOpen = false
                                showSwitcher = true
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.home_pair_another)) },
                            onClick = {
                                menuOpen = false
                                onPairAnotherHub()
                            },
                        )
                        DropdownMenuItem(
                            text = {
                                Text(
                                    text = stringResource(R.string.home_sign_out),
                                    color = MaterialTheme.colorScheme.error,
                                )
                            },
                            onClick = {
                                menuOpen = false
                                showSignOutConfirm = true
                            },
                        )
                    }
                },
            )
        },
    ) { padding ->
        SessionListScreen(
            viewModel = viewModel,
            onOpenSession = onOpenSession,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            onNewSession = onNewSession,
        )
    }

    if (showSwitcher) {
        HubSwitcherDialog(
            activeHubUrl = activeHubUrl,
            pairedHubs = pairedHubs,
            onSwitchHub = { hub ->
                showSwitcher = false
                if (hub != activeHubUrl) onSwitchHub(hub)
            },
            onPairAnotherHub = {
                showSwitcher = false
                onPairAnotherHub()
            },
            onDismiss = { showSwitcher = false },
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
                    Text(
                        text = stringResource(R.string.home_sign_out),
                        color = MaterialTheme.colorScheme.error,
                    )
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

@Composable
private fun HubSwitcherDialog(
    activeHubUrl: String,
    pairedHubs: List<String>,
    onSwitchHub: (String) -> Unit,
    onPairAnotherHub: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.home_switch_hub)) },
        text = {
            Column {
                pairedHubs.forEach { hub ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = hub == activeHubUrl, onClick = { onSwitchHub(hub) })
                        Text(
                            text = hub,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                }
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                TextButton(onClick = onPairAnotherHub) {
                    Text(stringResource(R.string.home_pair_another))
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.home_cancel))
            }
        },
    )
}

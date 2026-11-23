package app.hapi.companion.feature.share

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.companion.ui.components.AgentFlavorIcon

/** A destination picker; list management actions deliberately stay on Home. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareScreen(
    batch: PendingShare,
    hubUrl: String,
    pairedHubs: List<String>,
    sessions: SessionListViewModel,
    target: ShareTargetController,
    onSwitchHub: (String) -> Unit,
    onRetryFile: (String) -> Unit,
    onRemoveFile: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val list by sessions.uiState.collectAsState()
    val selection by target.state.collectAsState()
    var hubMenu by remember { mutableStateOf(false) }
    BackHandler(onBack = onCancel)
    DisposableEffect(sessions) {
        sessions.start()
        onDispose { sessions.stop() }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.share_title)) },
                navigationIcon = { IconButton(onClick = onCancel) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.share_cancel))
                } },
                actions = {
                    Column {
                        TextButton(onClick = { hubMenu = true }, enabled = !selection.busy,
                            modifier = Modifier.testTag("share-hub")) {
                            Text(Uri.parse(hubUrl).authority ?: hubUrl, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 160.dp))
                        }
                        DropdownMenu(expanded = hubMenu, onDismissRequest = { hubMenu = false }) {
                            pairedHubs.forEach { hub ->
                                DropdownMenuItem(
                                    text = { Text(Uri.parse(hub).authority ?: hub) },
                                    trailingIcon = { if (hub == hubUrl) Icon(Icons.Default.Check, null) },
                                    onClick = { hubMenu = false; onSwitchHub(hub) },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).testTag("share-picker")) {
            if (batch.text.isNotBlank()) item {
                Text(batch.text.take(600), maxLines = 4, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(16.dp))
            }
            items(batch.files, key = { it.id }) { file ->
                ListItem(
                    headlineContent = { Text(file.filename, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(when (file.status) {
                        SharedFileStatus.Copying -> stringResource(R.string.share_copying)
                        SharedFileStatus.Ready -> "${file.size / 1024} KiB"
                        SharedFileStatus.TooLarge -> stringResource(R.string.share_too_large)
                        SharedFileStatus.Unreadable -> stringResource(R.string.share_unreadable)
                        SharedFileStatus.Interrupted -> stringResource(R.string.share_interrupted)
                    }) },
                    trailingContent = {
                        Row {
                            if (file.status !in setOf(SharedFileStatus.Ready, SharedFileStatus.Copying)) {
                                TextButton(onClick = { onRetryFile(file.id) }, enabled = !selection.busy) {
                                    Text(stringResource(R.string.share_retry))
                                }
                            }
                            TextButton(onClick = { onRemoveFile(file.id) }, enabled = !selection.busy) {
                                Text(stringResource(R.string.share_remove))
                            }
                        }
                    },
                )
            }
            item {
                if (batch.files.any { it.status == SharedFileStatus.Copying } || selection.busy) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(start = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(stringResource(R.string.share_choose_session), modifier = Modifier.padding(vertical = 14.dp))
                    IconButton(onClick = sessions::refresh) { Icon(Icons.Default.Refresh, stringResource(R.string.share_refresh)) }
                }
                OutlinedTextField(
                    value = list.searchQuery, onValueChange = sessions::setSearchQuery,
                    placeholder = { Text(stringResource(R.string.share_search_hint)) }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("share-search"),
                )
                if (list.isOffline) Text(stringResource(R.string.share_offline),
                    color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                if (selection.failedSessionId != null) {
                    Text(selection.error ?: stringResource(R.string.share_target_failed),
                        color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                    TextButton(onClick = { target.select(selection.failedSessionId!!) }) {
                        Text(stringResource(R.string.share_retry))
                    }
                }
                if (list.isRefreshing && !list.hasLoaded) CircularProgressIndicator(Modifier.padding(16.dp))
                else if (list.rows.isEmpty()) Text(stringResource(R.string.share_no_sessions), modifier = Modifier.padding(16.dp))
            }
            items(list.rows, key = { "session:${it.id}" }) { row ->
                ListItem(
                    headlineContent = { Text(row.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Column {
                        listOfNotNull(row.meta, row.machine?.label).joinToString(" · ").takeIf { it.isNotBlank() }?.let {
                            Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        if (!row.summary.active) Text(stringResource(R.string.share_restore_label))
                    } },
                    leadingContent = { AgentFlavorIcon(row.flavor) },
                    modifier = Modifier.clickable(enabled = batch.canImport && !selection.busy) { target.select(row.id) }
                        .testTag("share-session-${row.id}"),
                )
            }
        }
    }
    selection.confirmSessionId?.let { sessionId ->
        AlertDialog(
            onDismissRequest = target::dismissConfirmation,
            title = { Text(stringResource(R.string.share_restore_title)) },
            text = { Text(stringResource(R.string.share_restore_message)) },
            confirmButton = { TextButton(onClick = { target.select(sessionId, confirmReopen = true) }) {
                Text(stringResource(R.string.share_restore_confirm))
            } },
            dismissButton = { TextButton(onClick = target::dismissConfirmation) { Text(stringResource(R.string.share_cancel)) } },
        )
    }
}

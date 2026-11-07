package app.hapi.companion.feature.newsession

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.CodexLocalSessionSummary
import java.text.DateFormat
import java.util.Date

/**
 * Codex session-import sheet (slices A+B) — Android presentation of the web
 * `CodexSessionSyncDialog` in its new-session (multi-select) usage: workdir
 * filter, search, badges, batch import, plus — since slice B — the header's
 * restart-client button, the archive long-press menu and its red error
 * banner. Rendering as a modal bottom sheet instead of a centered dialog
 * matches the screen's existing directory-browser presentation (declared
 * divergence); web's right-click opener is Android's long-press (no
 * context-menu API parity).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CodexSessionSyncDialog(
    state: CodexImportUiState,
    onDismiss: () -> Unit,
    onToggleSession: (String) -> Unit,
    onSelectAll: () -> Unit,
    onClearSelection: () -> Unit,
    onWorkdirFilterChange: (String) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onConfirm: () -> Unit,
    onArchive: (String) -> Unit,
    onRestart: () -> Unit,
) {
    val workdirOptions = CodexImportLogic.workdirOptions(state.sessions)
    val filtered = CodexImportLogic.filterSessions(state.sessions, state.workdirFilter, state.searchQuery)
    val busy = state.importing || state.loading
    val dateFormat = remember { DateFormat.getDateTimeInstance() }
    // Web keeps the open archive menu in dialog state (`archiveMenuSessionId`);
    // here it is plain composable state reset naturally on recomposition.
    var archiveMenuSessionId by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Header: title + description with the restart button on the
            // right (web dialog header row, L242-254).
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.codex_sync_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        stringResource(R.string.codex_sync_description),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onRestart, enabled = !state.restartingDesktop) {
                    Text(
                        if (state.restartingDesktop) {
                            stringResource(R.string.codex_sync_restart_confirming)
                        } else {
                            stringResource(R.string.codex_sync_restart)
                        },
                        maxLines = 1,
                    )
                }
            }

            // Restart outcome (web toasts restart.started/failed — inline
            // here, declared divergence).
            if (state.restartStarted) {
                Text(
                    stringResource(R.string.codex_sync_restart_started_title) + "\n" +
                        stringResource(R.string.codex_sync_restart_started_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.restartError?.let { error ->
                Text(
                    stringResource(R.string.codex_sync_restart_failed_title) + "\n" + error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            state.archiveError?.let { error ->
                Text(
                    error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // Selected count + batch actions (web header row).
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (state.dialogSelection.size == 1) {
                        stringResource(R.string.codex_sync_selected_count_one)
                    } else {
                        stringResource(R.string.codex_sync_selected_count_many, state.dialogSelection.size)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onClearSelection, enabled = state.dialogSelection.isNotEmpty()) {
                    Text(stringResource(R.string.codex_sync_clear_all))
                }
                TextButton(
                    onClick = onSelectAll,
                    enabled = !busy && state.sessions.isNotEmpty(),
                ) {
                    Text(stringResource(R.string.codex_sync_select_all))
                }
            }

            WorkdirFilterDropdown(
                selected = state.workdirFilter,
                options = workdirOptions,
                enabled = !busy && state.sessions.isNotEmpty(),
                onSelect = onWorkdirFilterChange,
            )

            OutlinedTextField(
                value = state.searchQuery,
                onValueChange = onSearchQueryChange,
                singleLine = true,
                enabled = !busy,
                label = { Text(stringResource(R.string.codex_sync_search)) },
                placeholder = { Text(stringResource(R.string.codex_sync_search_hint)) },
                modifier = Modifier.fillMaxWidth(),
            )

            when {
                state.loading -> Text(
                    stringResource(R.string.codex_sync_loading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                state.sessions.isEmpty() -> Text(
                    stringResource(R.string.codex_sync_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                filtered.isEmpty() -> Text(
                    stringResource(R.string.codex_sync_empty_for_workdir),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                // Height-bounded **lazy** list: rows past the cap stay
                // individually selectable by scrolling (the previous plain
                // Column clipped them with no way to reach them). Nested in
                // the sheet's outer scroll — the cap keeps the lazy list's
                // constraints bounded, and each row scrolls first.
                else -> LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 380.dp)
                        .testTag("codex-sync-session-list"),
                ) {
                    itemsIndexed(filtered, key = { _, session -> session.id }) { index, session ->
                        if (index > 0) HorizontalDivider()
                        CodexSessionRow(
                            session = session,
                            checked = session.id in state.dialogSelection,
                            isCurrent = session.id == state.selectedSessionId,
                            isImported = state.importedMarkers.containsKey(session.id),
                            enabled = !busy,
                            archiveMenuOpen = archiveMenuSessionId == session.id,
                            onToggle = { onToggleSession(session.id) },
                            onOpenArchiveMenu = { archiveMenuSessionId = session.id },
                            onArchive = {
                                archiveMenuSessionId = null
                                onArchive(session.id)
                            },
                            onCloseArchiveMenu = { archiveMenuSessionId = null },
                            dateFormat = dateFormat,
                            modifier = Modifier.testTag("codex-sync-session-${session.id}"),
                        )
                    }
                }
            }

            // Single-row Confirm landed on a row that was archived/removed
            // externally after it was checked: the dialog stays open with
            // the selection intact (never a silent close with no selection).
            if (state.confirmSelectionMissing) {
                Text(
                    stringResource(R.string.codex_sync_confirm_selection_missing),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            state.importError?.let { error ->
                Text(
                    error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(
                    onClick = onDismiss,
                    enabled = !state.importing && !state.restartingDesktop,
                ) {
                    Text(stringResource(R.string.codex_sync_cancel))
                }
                Button(
                    onClick = onConfirm,
                    enabled = !state.importing && !state.loading && state.dialogSelection.isNotEmpty(),
                ) {
                    Text(
                        if (state.importing) {
                            stringResource(R.string.codex_sync_importing)
                        } else {
                            stringResource(R.string.codex_sync_import)
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkdirFilterDropdown(
    selected: String,
    options: List<String>,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val allLabel = stringResource(R.string.codex_sync_cwd_filter_all)
    val selectedLabel = if (selected == CodexImportLogic.ALL_WORKDIR_FILTER) allLabel else selected

    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = it },
    ) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(stringResource(R.string.codex_sync_cwd_filter)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded && enabled) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled),
        )
        ExposedDropdownMenu(
            expanded = expanded && enabled,
            onDismissRequest = { expanded = false },
        ) {
            DropdownMenuItem(
                text = { Text(allLabel) },
                onClick = {
                    expanded = false
                    onSelect(CodexImportLogic.ALL_WORKDIR_FILTER)
                },
            )
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    onClick = {
                        expanded = false
                        onSelect(option)
                    },
                )
            }
        }
    }
}

/**
 * One selectable session row: checkbox + title + badges + preview + cwd +
 * time. Long-press (web: long-press **or** right-click, L353-367) opens the
 * archive menu (L419-436): Archive runs the parent action, Cancel just
 * closes it. [combinedClickable] keeps tap-toggle and long-press-menu as one
 * gesture handler so a long press never toggles the checkbox.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CodexSessionRow(
    session: CodexLocalSessionSummary,
    checked: Boolean,
    isCurrent: Boolean,
    isImported: Boolean,
    enabled: Boolean,
    archiveMenuOpen: Boolean,
    onToggle: () -> Unit,
    onOpenArchiveMenu: () -> Unit,
    onArchive: () -> Unit,
    onCloseArchiveMenu: () -> Unit,
    dateFormat: DateFormat,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    enabled = enabled,
                    role = Role.Checkbox,
                    onClick = onToggle,
                    onLongClick = onOpenArchiveMenu,
                ),
            verticalAlignment = Alignment.Top,
        ) {
            Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    session.title,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val badges = buildList {
                    if (isCurrent) add(stringResource(R.string.codex_sync_current))
                    if (isImported) add(stringResource(R.string.codex_sync_imported))
                    if (CodexImportLogic.isOriginal(session)) add(stringResource(R.string.codex_sync_original))
                    if (CodexImportLogic.isForked(session)) add(stringResource(R.string.codex_sync_fork))
                }
                if (badges.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        badges.forEach { badge ->
                            Badge(badge)
                        }
                    }
                }
                Text(
                    CodexImportLogic.previewOf(session),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                CodexImportLogic.cwdOf(session)?.let { cwd ->
                    Text(
                        "${stringResource(R.string.codex_sync_cwd)}: $cwd",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Text(
                    dateFormat.format(Date(session.modifiedAt)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Archive menu (web L419-436): two items — Archive runs the parent
        // action (the controller owns the API + row removal + error banner),
        // Cancel just closes the menu.
        DropdownMenu(
            expanded = archiveMenuOpen,
            onDismissRequest = onCloseArchiveMenu,
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.codex_sync_archive_action)) },
                onClick = onArchive,
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.codex_sync_cancel)) },
                onClick = onCloseArchiveMenu,
            )
        }
    }
}

@Composable
private fun Badge(label: String) {
    Surface(
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

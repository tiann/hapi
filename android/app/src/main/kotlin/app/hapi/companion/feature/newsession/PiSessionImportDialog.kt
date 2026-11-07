package app.hapi.companion.feature.newsession

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.protocol.wire.PiLocalSessionSummary
import java.text.DateFormat
import java.util.Date

/**
 * Pi session-import sheet (slice C) — Android presentation of the web
 * `PiSessionImportDialog`: amber concurrency warning, directory filter +
 * search (only with a non-empty list), Imported / Needs-attention badges,
 * multi-select with one-continue-now confirm semantics, and batch import.
 * Rendering as a modal bottom sheet instead of a centered dialog matches the
 * codex import dialog's presentation (declared divergence); the web toasts
 * for import outcomes render inline here (same divergence).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PiSessionImportDialog(
    state: PiImportUiState,
    onDismiss: () -> Unit,
    onToggleSession: (String) -> Unit,
    onSelectAll: () -> Unit,
    onClearSelection: () -> Unit,
    onDirectoryFilterChange: (String) -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onConfirm: () -> Unit,
) {
    val directories = PiImportLogic.directoryOptions(state.sessions)
    val filtered = PiImportLogic.filterSessions(state.sessions, state.directoryFilter, state.searchQuery)
    val busy = state.importing || state.loading
    val dateFormat = remember { DateFormat.getDateTimeInstance() }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                stringResource(R.string.pi_import_dialog_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                stringResource(R.string.pi_import_dialog_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Amber concurrency warning — always shown (web banner).
            Surface(
                shape = MaterialTheme.shapes.small,
                color = MaterialTheme.colorScheme.tertiaryContainer,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    stringResource(R.string.pi_import_dialog_concurrent_warning),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }

            // Import outcomes (web toasts — inline here, declared divergence).
            state.successNotice?.let { notice ->
                Text(
                    notice,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            state.failedNotice?.let { notice ->
                Text(
                    notice,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // Selected count + batch actions (web header row): ClearAll and
            // SelectAll are blocked by an import in flight, not by a scan.
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (state.dialogSelection.size == 1) {
                        stringResource(R.string.pi_import_selected_count_one)
                    } else {
                        stringResource(R.string.pi_import_selected_count_many, state.dialogSelection.size)
                    },
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = onClearSelection,
                    enabled = state.dialogSelection.isNotEmpty() && !state.importing,
                ) {
                    Text(stringResource(R.string.pi_import_clear_all))
                }
                TextButton(
                    onClick = onSelectAll,
                    enabled = filtered.isNotEmpty() && !state.importing,
                ) {
                    Text(stringResource(R.string.pi_import_select_all))
                }
            }

            // Directory + search only once a list exists (web
            // `props.sessions.length > 0` gate); blocked by an import only.
            if (state.sessions.isNotEmpty()) {
                DirectoryFilterDropdown(
                    selected = state.directoryFilter,
                    options = directories,
                    enabled = !state.importing,
                    onSelect = onDirectoryFilterChange,
                )
                OutlinedTextField(
                    value = state.searchQuery,
                    onValueChange = onSearchQueryChange,
                    singleLine = true,
                    enabled = !state.importing,
                    placeholder = { Text(stringResource(R.string.pi_import_search)) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            when {
                state.loading -> Text(
                    stringResource(R.string.pi_import_loading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                filtered.isEmpty() -> Text(
                    stringResource(R.string.pi_import_empty),
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
                        .testTag("pi-import-session-list"),
                ) {
                    itemsIndexed(filtered, key = { _, session -> session.id }) { index, session ->
                        if (index > 0) HorizontalDivider()
                        PiSessionRow(
                            session = session,
                            checked = session.id in state.dialogSelection,
                            enabled = !busy,
                            onToggle = { onToggleSession(session.id) },
                            dateFormat = dateFormat,
                            modifier = Modifier.testTag("pi-import-session-${session.id}"),
                        )
                    }
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                // Web uses the global `button.cancel`; Android has no global
                // cancel key (per-feature convention) — shared with the codex
                // import dialog, which carries the identical label.
                TextButton(onClick = onDismiss, enabled = !state.importing) {
                    Text(stringResource(R.string.codex_sync_cancel))
                }
                Button(
                    onClick = onConfirm,
                    enabled = !state.importing && !state.loading && state.dialogSelection.isNotEmpty(),
                ) {
                    Text(
                        if (state.importing) {
                            stringResource(R.string.pi_import_importing)
                        } else {
                            stringResource(R.string.pi_import_confirm)
                        },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DirectoryFilterDropdown(
    selected: String,
    options: List<String>,
    enabled: Boolean,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val allLabel = stringResource(R.string.pi_import_all_directories)
    val selectedLabel = if (selected == PiImportLogic.ALL_DIRECTORIES) allLabel else selected

    ExposedDropdownMenuBox(
        expanded = expanded && enabled,
        onExpandedChange = { if (enabled) expanded = it },
    ) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
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
                    onSelect(PiImportLogic.ALL_DIRECTORIES)
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
 * One selectable session row: checkbox + title + Imported badge
 * (`hapiSessionId`) + red Needs-attention text (`importState` diverged or
 * failed) + preview line (`lastUserMessage ?? cwd ?? id`) + time and
 * message count.
 */
@Composable
private fun PiSessionRow(
    session: PiLocalSessionSummary,
    checked: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
    dateFormat: DateFormat,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onToggle),
        verticalAlignment = Alignment.Top,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    session.title,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (session.hapiSessionId != null) {
                    Badge(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ) {
                        Text(
                            stringResource(R.string.pi_import_imported),
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                if (session.importState == "diverged" || session.importState == "failed") {
                    Text(
                        stringResource(R.string.pi_import_needs_attention),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            Text(
                PiImportLogic.previewOf(session),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                dateFormat.format(Date(session.modifiedAt)) + " · " +
                    "${session.messageCount} ${stringResource(R.string.pi_import_messages)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

package app.hapi.companion.feature.directorybrowser

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/** Reusable presentation for [RemoteDirectoryBrowserController]. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun RemoteDirectoryBrowserSheet(
    state: RemoteDirectoryBrowserState,
    onDismiss: () -> Unit,
    onNavigate: (String) -> Unit,
    onNavigateEntry: (String) -> Unit,
    onNavigateUp: () -> Unit,
    onRefresh: () -> Unit,
    onIncludeHiddenChange: (Boolean) -> Unit,
    onSelect: (String) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(stringResource(R.string.directory_browser_choose_directory), style = MaterialTheme.typography.titleMedium)
            if (state.roots.size > 1) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    state.roots.forEach { root ->
                        FilterChip(
                            selected = RemoteDirectoryPath.isWithinRoot(state.path, root),
                            onClick = { onNavigate(root) },
                            label = { Text(root, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        )
                    }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                state.breadcrumbs.forEach { breadcrumb ->
                    TextButton(onClick = { onNavigate(breadcrumb.path) }) {
                        Text(breadcrumb.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onNavigateUp, enabled = state.canGoUp && !state.loading) {
                    Icon(
                        Icons.Default.KeyboardArrowUp,
                        contentDescription = stringResource(R.string.directory_browser_up),
                    )
                }
                IconButton(onClick = onRefresh, enabled = !state.loading) {
                    Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.directory_browser_refresh))
                }
                Text(
                    state.path,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(stringResource(R.string.directory_browser_show_hidden), style = MaterialTheme.typography.labelSmall)
                Switch(checked = state.includeHidden, onCheckedChange = onIncludeHiddenChange)
            }
            when {
                state.loading -> CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
                state.error != null -> Text(
                    state.error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
                state.entries.isEmpty() -> Text(
                    stringResource(R.string.directory_browser_empty),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 360.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    state.entries.forEachIndexed { index, entry ->
                        if (index > 0) HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            onClick = { onNavigateEntry(entry.name) },
                        )
                    }
                }
            }
            Button(
                onClick = { onSelect(state.path) },
                enabled = !state.loading && state.error == null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.directory_browser_select_current))
            }
        }
    }
}

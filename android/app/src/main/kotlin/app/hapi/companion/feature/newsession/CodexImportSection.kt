package app.hapi.companion.feature.newsession

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Codex-history inline section of the create form (slice A) — port of web
 * `NewSession/CodexImportActions.tsx`: title, selected session's title or
 * the description, Clear (only while something is selected), Choose-history
 * (shows the loading label while a list load runs), and the load error.
 */
@Composable
fun CodexImportSection(
    state: CodexImportSectionUi,
    isDisabled: Boolean,
    onChooseHistory: () -> Unit,
    onClear: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.codex_sync_inline_title),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    state.selectedTitle
                        ?: stringResource(R.string.codex_sync_inline_description),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.selectedTitle != null) {
                TextButton(onClick = onClear, enabled = !isDisabled) {
                    Text(stringResource(R.string.codex_sync_inline_clear))
                }
            }
            OutlinedButton(
                onClick = onChooseHistory,
                enabled = !isDisabled && !state.loading,
            ) {
                Text(
                    when {
                        state.loading -> stringResource(R.string.codex_sync_loading)
                        // Keeps an in-flight bulk import observable here too —
                        // the sheet may have been dismissed mid-import.
                        state.busy -> stringResource(R.string.codex_sync_importing)
                        else -> stringResource(R.string.codex_sync_inline_choose)
                    },
                )
            }
        }
        state.error?.let { error ->
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        // Duplicate detection failed after an otherwise successful import
        // (web `duplicates.detect.failed.*` toast — inline here, divergence).
        state.duplicateDetectError?.let { detail ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    stringResource(R.string.codex_sync_duplicates_detect_failed_title),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

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
 * Pi-history inline section of the create form (slice C) — port of web
 * `NewSession/PiImportActions.tsx`: title, selected session's title or the
 * description, Clear (only while something is selected), Choose-history
 * (shows the scanning label while a scan runs), and the scan error.
 */
@Composable
fun PiImportActions(
    state: PiImportSectionUi,
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
                    stringResource(R.string.pi_import_inline_title),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    state.selectedTitle
                        ?: stringResource(R.string.pi_import_inline_description),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.selectedTitle != null) {
                TextButton(onClick = onClear, enabled = !isDisabled) {
                    Text(stringResource(R.string.pi_import_inline_clear))
                }
            }
            OutlinedButton(
                onClick = onChooseHistory,
                enabled = !isDisabled && !state.loading,
            ) {
                Text(
                    if (state.loading) {
                        stringResource(R.string.pi_import_loading)
                    } else {
                        stringResource(R.string.pi_import_inline_choose)
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
    }
}

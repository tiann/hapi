package app.hapi.companion.feature.newsession

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme

/**
 * Duplicate-merge confirmation (slice B) — the Android twin of web
 * `ui/ConfirmDialog` as mounted by `NewSession/index.tsx` for
 * `codexSync.duplicates.confirm.*`. Android keeps it a purpose-built
 * AlertDialog in the `SessionOpsDialogs` style instead of generalizing a
 * confirm dialog (declared divergence, per-slice spec): [isPending] swaps
 * the confirm label and disables both buttons, and [error] renders inline
 * while the dialog stays open — the web rethrow semantics of
 * `handleMergeDuplicateSessions` (failure must leave the dialog retryable).
 */
@Composable
fun DuplicateMergeConfirmDialog(
    isPending: Boolean,
    error: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.codex_sync_duplicates_confirm_title)) },
        text = {
            Column {
                Text(stringResource(R.string.codex_sync_duplicates_confirm_description))
                error?.let { message ->
                    Text(
                        message,
                        modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !isPending) {
                Text(
                    if (isPending) {
                        stringResource(R.string.codex_sync_duplicates_confirm_confirming)
                    } else {
                        stringResource(R.string.codex_sync_duplicates_confirm_confirm)
                    },
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isPending) {
                Text(stringResource(R.string.codex_sync_cancel))
            }
        },
    )
}

// -------------------------------------------------------------- previews --

@Preview
@Composable
private fun DuplicateMergeConfirmDialogPreview() {
    HapiTheme {
        DuplicateMergeConfirmDialog(isPending = false, error = null, onConfirm = {}, onDismiss = {})
    }
}

@Preview
@Composable
private fun DuplicateMergeConfirmDialogErrorPreview() {
    HapiTheme {
        DuplicateMergeConfirmDialog(
            isPending = true,
            error = "Failed to merge duplicate sessions.",
            onConfirm = {},
            onDismiss = {},
        )
    }
}

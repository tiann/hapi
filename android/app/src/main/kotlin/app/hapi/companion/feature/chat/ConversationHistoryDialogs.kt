package app.hapi.companion.feature.chat

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme

/**
 * Conversation-history confirm dialogs (fork / rewind), mirroring the web
 * `ConfirmDialog` flow in `MessageActions.tsx`: fork explains the current
 * session is untouched; rewind warns the later history is permanently
 * removed. While the RPC is in flight the confirm button relabels to the
 * pending verb and dismiss is refused (web keeps the dialog open on error;
 * here the dialog closes and a typed snackbar notice carries the failure).
 */

@Composable
fun HistoryActionConfirmDialog(
    action: PendingHistoryAction,
    pending: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val (titleRes, descriptionRes, confirmRes) = when (action) {
        is PendingHistoryAction.ForkCurrent, is PendingHistoryAction.ForkAtMessage -> Triple(
            R.string.chat_history_fork_confirm_title,
            R.string.chat_history_fork_confirm_description,
            R.string.chat_history_fork,
        )
        is PendingHistoryAction.Rewind -> Triple(
            R.string.chat_history_rewind_confirm_title,
            R.string.chat_history_rewind_confirm_description,
            R.string.chat_history_rewind,
        )
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(titleRes)) },
        text = { Text(stringResource(descriptionRes)) },
        confirmButton = {
            TextButton(enabled = !pending, onClick = onConfirm) {
                Text(
                    stringResource(
                        if (pending) {
                            when (action) {
                                is PendingHistoryAction.Rewind -> R.string.chat_history_rewind_pending
                                else -> R.string.chat_history_fork_pending
                            }
                        } else {
                            confirmRes
                        }
                    )
                )
            }
        },
        dismissButton = {
            TextButton(enabled = !pending, onClick = onDismiss) {
                Text(stringResource(R.string.chat_cancel))
            }
        },
    )
}

/**
 * Rewind fallback (`ambiguous_native_boundary_fork_safe`): the hub refused
 * to rewind because the native boundary is ambiguous, but forking at this
 * point is known-safe — offer "Fork here" instead (web
 * `message.rewind.fallback*`).
 */
@Composable
fun RewindFallbackDialog(
    pending: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_history_rewind_fallback_title)) },
        text = { Text(stringResource(R.string.chat_history_rewind_fallback_description)) },
        confirmButton = {
            TextButton(enabled = !pending, onClick = onConfirm) {
                Text(
                    stringResource(
                        if (pending) {
                            R.string.chat_history_rewind_fallback_pending
                        } else {
                            R.string.chat_history_rewind_fallback_fork
                        }
                    )
                )
            }
        },
        dismissButton = {
            TextButton(enabled = !pending, onClick = onDismiss) {
                Text(stringResource(R.string.chat_cancel))
            }
        },
    )
}

// -------------------------------------------------------------- previews --

@Preview
@Composable
private fun ForkConfirmDialogPreview() {
    HapiTheme {
        HistoryActionConfirmDialog(
            action = PendingHistoryAction.ForkCurrent,
            pending = false,
            onConfirm = {},
            onDismiss = {},
        )
    }
}

@Preview
@Composable
private fun RewindConfirmDialogPreview() {
    HapiTheme {
        HistoryActionConfirmDialog(
            action = PendingHistoryAction.Rewind(messageLocalId = "m1"),
            pending = true,
            onConfirm = {},
            onDismiss = {},
        )
    }
}

@Preview
@Composable
private fun RewindFallbackDialogPreview() {
    HapiTheme {
        RewindFallbackDialog(pending = false, onConfirm = {}, onDismiss = {})
    }
}

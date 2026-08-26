package app.hapi.companion.feature.sessions

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme

/**
 * Session-op confirmation dialogs (B-M3ce), shared by the session-list sheet
 * and the chat top-bar overflow menu.
 */

/** Rename prompt: prefilled text field, confirm disabled while blank (hub: 1–255 chars). */
@Composable
fun RenameSessionDialog(
    initialName: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf(initialName) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_rename_title)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(255) },
                singleLine = true,
                placeholder = { Text(stringResource(R.string.sessions_rename_placeholder)) },
            )
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank(),
                onClick = { onConfirm(name.trim()) },
            ) { Text(stringResource(R.string.sessions_action_rename)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.sessions_cancel)) }
        },
    )
}

/** Delete confirmation — destructive and irreversible on the hub. */
@Composable
fun DeleteSessionDialog(
    sessionTitle: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_delete_title)) },
        text = {
            Text(stringResource(R.string.sessions_delete_message, sessionTitle))
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    stringResource(R.string.sessions_action_delete),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.sessions_cancel)) }
        },
    )
}

// -------------------------------------------------------------- previews --

@Preview
@Composable
private fun RenameSessionDialogPreview() {
    HapiTheme {
        RenameSessionDialog(initialName = "Fixture sweep", onConfirm = {}, onDismiss = {})
    }
}

@Preview
@Composable
private fun DeleteSessionDialogPreview() {
    HapiTheme {
        DeleteSessionDialog(sessionTitle = "Fixture sweep", onConfirm = {}, onDismiss = {})
    }
}

package app.hapi.companion.feature.sessions

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Session-op confirmation dialogs (B-M3ce), shared by the session-list sheet
 * and the chat top-bar overflow menu.
 */

/**
 * Rename prompt: prefilled text field, confirm disabled while blank (hub: 1–255 chars).
 *
 * When [onSuggestTitle] is present (hub capability `titleSuggestion`) an
 * extra Suggest button appears. It mirrors the web `RenameSessionDialog`
 * save semantics: an **unedited** generated title saves via
 * [onConfirmGenerated] (the hub summary), while anything typed or edited
 * saves via [onConfirm] (a plain rename).
 */
@Composable
fun RenameSessionDialog(
    initialName: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
    onSuggestTitle: (suspend () -> String)? = null,
    onConfirmGenerated: ((String) -> Unit)? = null,
) {
    var name by remember { mutableStateOf(initialName) }
    // Web's draftSource: 'manual' | 'generated'. Typing flips generated → manual,
    // so an edited suggestion saves as a rename, an untouched one as the summary.
    var generatedDraft by remember { mutableStateOf(false) }
    var generating by remember { mutableStateOf(false) }
    var suggestFailed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun submit() {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        // Unedited manual no-op: the web closes without a request.
        if (!generatedDraft && trimmed == initialName.trim()) {
            onDismiss()
            return
        }
        if (generatedDraft && onConfirmGenerated != null) {
            onConfirmGenerated(trimmed)
        } else {
            onConfirm(trimmed)
        }
        // The caller closes the dialog after wiring its action.
        onDismiss()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_rename_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = {
                        name = it.take(255)
                        generatedDraft = false
                        suggestFailed = false
                    },
                    singleLine = true,
                    enabled = !generating,
                    placeholder = { Text(stringResource(R.string.sessions_rename_placeholder)) },
                    isError = suggestFailed,
                    supportingText = if (suggestFailed) {
                        { Text(stringResource(R.string.sessions_rename_suggest_error)) }
                    } else {
                        null
                    },
                )
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && !generating,
                onClick = { submit() },
            ) { Text(stringResource(R.string.sessions_action_rename_save)) }
        },
        dismissButton = {
            Row {
                if (onSuggestTitle != null) {
                    TextButton(
                        enabled = !generating,
                        onClick = {
                            scope.launch {
                                generating = true
                                suggestFailed = false
                                try {
                                    val suggested = onSuggestTitle().trim()
                                    if (suggested.isEmpty()) {
                                        suggestFailed = true
                                    } else {
                                        name = suggested.take(255)
                                        generatedDraft = true
                                    }
                                } catch (cancellation: CancellationException) {
                                    throw cancellation
                                } catch (failure: Exception) {
                                    suggestFailed = true
                                } finally {
                                    generating = false
                                }
                            }
                        },
                    ) {
                        Text(
                            if (generating) {
                                stringResource(R.string.sessions_rename_suggesting)
                            } else {
                                stringResource(R.string.sessions_rename_suggest)
                            }
                        )
                    }
                }
                TextButton(
                    enabled = !generating,
                    onClick = onDismiss,
                ) { Text(stringResource(R.string.sessions_cancel)) }
            }
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

/**
 * Mark-all-read confirmation — local device state, but irreversible in the
 * "unread markers are gone" sense, so it shares the confirm-dialog pattern
 * with the destructive ops (web parity).
 */
@Composable
fun MarkAllReadDialog(
    count: Int,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_mark_all_read_title)) },
        text = {
            Text(stringResource(R.string.sessions_mark_all_read_description, count))
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.sessions_mark_all_read_confirm))
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

@Preview
@Composable
private fun MarkAllReadDialogPreview() {
    HapiTheme {
        MarkAllReadDialog(count = 3, onConfirm = {}, onDismiss = {})
    }
}

package app.hapi.companion.feature.chat

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.MarkdownLinkHandler
import app.hapi.protocol.markdown.HrefDecision

/**
 * The confirm-aware URL opener the M2d1 markdown module defers to this
 * milestone: [HrefDecision.Allowed] dispatches immediately,
 * [HrefDecision.ConfirmFirst] asks first (custom schemes), blocked never gets
 * here. Workspace-file citations route to the session file viewer (B-M4c) via
 * [onOpenFile] — the chat screen wires it to `chat/{id}/file` in full mode,
 * passing the cited line along as a hint.
 */
@Composable
fun rememberChatLinkHandler(
    onOpenFile: (path: String, line: Int?) -> Unit = { _, _ -> },
): MarkdownLinkHandler {
    val context = LocalContext.current
    var confirmUrl by remember { mutableStateOf<String?>(null) }

    confirmUrl?.let { url ->
        AlertDialog(
            onDismissRequest = { confirmUrl = null },
            title = { Text(stringResource(R.string.chat_link_open_title)) },
            text = { Text(url) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmUrl = null
                        context.openUrl(url)
                    },
                ) { Text(stringResource(R.string.chat_link_open)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmUrl = null }) { Text(stringResource(R.string.chat_cancel)) }
            },
        )
    }

    return remember(context, onOpenFile) {
        object : MarkdownLinkHandler {
            override fun onFilePath(path: String, line: Int?) = onOpenFile(path, line)

            override fun onUrl(url: String, decision: HrefDecision) {
                when (decision) {
                    is HrefDecision.Allowed -> context.openUrl(url)
                    is HrefDecision.ConfirmFirst -> confirmUrl = url
                    is HrefDecision.Blocked -> Unit
                }
            }
        }
    }
}

private fun Context.openUrl(url: String) {
    try {
        startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(this, getString(R.string.chat_link_no_app), Toast.LENGTH_SHORT).show()
    }
}

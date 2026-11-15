package app.hapi.companion.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.hapi.companion.R
import app.hapi.companion.ui.theme.hapi
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal const val CLIPBOARD_TEXT_LIMIT = 64 * 1024

/**
 * Copy-or-export state shared by [FullTextAction] and the transcript's
 * response actions: plain clipboard copy up to [CLIPBOARD_TEXT_LIMIT], a
 * UTF-8 file through the sharesheet beyond it (or after a clipboard failure).
 */
internal class FullTextCopyState(
    val export: Boolean,
    val copied: Boolean,
    val busy: Boolean,
    val label: String,
    val invoke: () -> Unit,
)

/**
 * Binder carries only small text or a content URI, never a megabyte log.
 * [revertAfterMs] returns a successful copy to its idle state (web/iOS
 * transient checkmark); null keeps "Copied" until the source changes.
 */
@Composable
internal fun rememberFullTextCopy(source: String, revertAfterMs: Long? = null): FullTextCopyState {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var copyFailed by remember(source) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var copied by remember(source) { mutableStateOf(false) }
    var failed by remember(source) { mutableStateOf(false) }
    val export = source.length > CLIPBOARD_TEXT_LIMIT || copyFailed
    if (revertAfterMs != null && copied) {
        LaunchedEffect(Unit) {
            delay(revertAfterMs)
            copied = false
        }
    }
    val action: () -> Unit = {
        if (!export) {
            copyFailed = runCatching {
                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("HAPI", source))
            }.isFailure
            copied = !copyFailed
        } else {
            busy = true
            scope.launch {
                try {
                    val file = withContext(Dispatchers.IO) {
                        val directory = File(context.cacheDir, "text-exports").apply { mkdirs() }
                        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }?.forEach { it.delete() }
                        File.createTempFile("hapi-", ".txt", directory).apply { writeText(source, Charsets.UTF_8) }
                    }
                    val uri = FileProvider.getUriForFile(context, context.packageName + ".attachments", file)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_STREAM, uri)
                        clipData = ClipData.newRawUri("HAPI", uri)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(Intent.createChooser(send, null))
                    failed = false
                } catch (cancel: kotlinx.coroutines.CancellationException) {
                    throw cancel
                } catch (_: Exception) {
                    failed = true
                } finally {
                    busy = false
                }
            }
        }
    }
    val label = stringResource(when {
            failed -> R.string.chat_export_retry
            export -> R.string.chat_export_full_content
            copied -> R.string.chat_content_copied
            else -> R.string.chat_copy_full_content
        })
    return FullTextCopyState(export = export, copied = copied, busy = busy, label = label, invoke = action)
}

/** The copy/check/share glyph for [state], tinted primary after a copy. */
@Composable
internal fun FullTextCopyIcon(state: FullTextCopyState, size: Dp, contentDescription: String? = state.label) {
    val iconModifier = Modifier.size(size)
    val tint = if (state.copied && !state.export) MaterialTheme.colorScheme.primary else MaterialTheme.hapi.textSecondary
    when {
        state.export -> Icon(Icons.Default.Share, contentDescription, iconModifier, tint = tint)
        state.copied -> Icon(painterResource(R.drawable.ic_sym_check), contentDescription, iconModifier, tint = tint)
        else -> Icon(painterResource(R.drawable.ic_sym_content_copy), contentDescription, iconModifier, tint = tint)
    }
}

@Composable
internal fun FullTextAction(source: String, compact: Boolean = false) {
    val state = rememberFullTextCopy(source)
    if (compact) {
        // Compact artwork, not a smaller touch target. Keep all states the
        // same size so copying/exporting never changes the code header layout.
        IconButton(enabled = !state.busy, onClick = state.invoke, modifier = Modifier.size(48.dp)) {
            FullTextCopyIcon(state, 16.dp)
        }
    } else {
        TextButton(enabled = !state.busy, onClick = state.invoke) { Text(state.label) }
    }
}

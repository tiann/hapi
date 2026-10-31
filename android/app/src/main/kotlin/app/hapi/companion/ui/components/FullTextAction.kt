package app.hapi.companion.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.hapi.companion.R
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal const val CLIPBOARD_TEXT_LIMIT = 64 * 1024

/** Binder carries only small text or a content URI, never a megabyte log. */
@Composable
internal fun FullTextAction(source: String, compact: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var copyFailed by remember(source) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var copied by remember(source) { mutableStateOf(false) }
    var failed by remember(source) { mutableStateOf(false) }
    val export = source.length > CLIPBOARD_TEXT_LIMIT || copyFailed
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
    if (compact) {
        // Compact artwork, not a smaller touch target. Keep all states the
        // same size so copying/exporting never changes the code header layout.
        IconButton(enabled = !busy, onClick = action, modifier = Modifier.size(48.dp)) {
            val iconModifier = Modifier.size(18.dp)
            if (export || copied) Icon(if (export) Icons.Default.Share else Icons.Default.Check, label, iconModifier)
            else Icon(painterResource(R.drawable.ic_content_copy), label, iconModifier)
        }
    } else {
        TextButton(enabled = !busy, onClick = action) { Text(label) }
    }
}

package app.hapi.companion.feature.sessions

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.SessionExportArtifact
import app.hapi.protocol.chat.SessionExportFormat
import app.hapi.protocol.chat.formatExportSize
import java.io.File
import java.text.NumberFormat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Export dialog — the Android twin of `SessionExportDialog.tsx`, with the
 * web's single download button split into the platform's two outlets:
 * SAVE (system file picker via SAF) and SHARE (`ACTION_SEND` of a
 * FileProvider cache file, the `FullTextAction` precedent).
 */

/**
 * `ACTION_CREATE_DOCUMENT` contract (mime, suggested filename) → user-picked
 * uri. Self-contained on purpose: the stack-only files feature owns its own
 * named-document variant and this slice must not depend on it.
 */
class CreateSessionExportDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.first)
            .putExtra(Intent.EXTRA_TITLE, input.second)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == Activity.RESULT_OK) intent?.data else null
}

/** `toLocaleString()` grouping for the message-count / limit interpolations. */
private fun grouped(value: Int): String = NumberFormat.getIntegerInstance().format(value)

@Composable
fun SessionExportDialog(
    sessionId: String,
    support: SessionExportSupport,
    onDismiss: () -> Unit,
    /** Snackbar feedback after a successful SAF save ("Saved {filename}"). */
    onSaved: (filename: String) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val controller = remember(sessionId, support) {
        SessionExportController(sessionId, support.fetcher, support.formatStore, scope)
    }
    val state by controller.state.collectAsState()
    val format by controller.format.collectAsState()
    val exporting = state is SessionExportUiState.Exporting
    val ready = state is SessionExportUiState.Ready
    val warned = state is SessionExportUiState.Warned

    fun shareArtifact(artifact: SessionExportArtifact) {
        scope.launch {
            try {
                val uri = withContext(Dispatchers.IO) {
                    // FullTextAction precedent: cache/text-exports with a 24h sweep.
                    val directory = File(context.cacheDir, "text-exports").apply { mkdirs() }
                    directory.listFiles()
                        ?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }
                        ?.forEach { it.delete() }
                    val file = File.createTempFile(
                        "hapi-export-",
                        ".${artifact.format.extension}",
                        directory,
                    ).apply { writeText(artifact.text, Charsets.UTF_8) }
                    FileProvider.getUriForFile(context, context.packageName + ".attachments", file)
                }
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = artifact.format.mimeType
                    putExtra(Intent.EXTRA_STREAM, uri)
                    clipData = ClipData.newRawUri("HAPI", uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                context.startActivity(Intent.createChooser(send, null))
                controller.reset()
                onDismiss()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                controller.writeFailed()
            }
        }
    }

    val saveLauncher = rememberLauncherForActivityResult(CreateSessionExportDocument()) { uri ->
        val artifact = (controller.state.value as? SessionExportUiState.Ready)?.artifact
        if (uri == null || artifact == null) {
            // Picker cancelled (or state lost): back to Idle so Save/Share work again.
            controller.reset()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            val written = withContext(Dispatchers.IO) {
                try {
                    context.contentResolver.openOutputStream(uri)?.use { stream ->
                        stream.write(artifact.text.toByteArray(Charsets.UTF_8))
                    } != null
                } catch (_: Exception) {
                    false
                }
            }
            if (written) {
                controller.reset()
                onSaved(artifact.filename)
                onDismiss()
            } else {
                controller.writeFailed()
            }
        }
    }

    // The web downloads as soon as the payload builds; Android hands the
    // ready artifact straight to the chosen system flow.
    LaunchedEffect(state) {
        val current = state as? SessionExportUiState.Ready ?: return@LaunchedEffect
        when (current.outlet) {
            SessionExportOutlet.SAVE ->
                saveLauncher.launch(current.artifact.format.mimeType to current.artifact.filename)
            SessionExportOutlet.SHARE -> shareArtifact(current.artifact)
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.session_export_title)) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.session_export_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                SessionExportFormatOption(
                    title = stringResource(R.string.session_export_format_json),
                    description = stringResource(R.string.session_export_format_json_description),
                    selected = format == SessionExportFormat.JSON,
                    enabled = !exporting,
                    onSelect = { controller.setFormat(SessionExportFormat.JSON) },
                )
                SessionExportFormatOption(
                    title = stringResource(R.string.session_export_format_markdown),
                    description = stringResource(R.string.session_export_format_markdown_description),
                    selected = format == SessionExportFormat.MARKDOWN,
                    enabled = !exporting,
                    onSelect = { controller.setFormat(SessionExportFormat.MARKDOWN) },
                )
                (state as? SessionExportUiState.Warned)?.let { warnedState ->
                    Surface(
                        color = MaterialTheme.colorScheme.secondaryContainer,
                        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(
                                text = stringResource(R.string.session_export_warning_title),
                                style = MaterialTheme.typography.labelLarge,
                            )
                            Text(
                                text = stringResource(
                                    R.string.session_export_warning_description,
                                    grouped(warnedState.warning.count),
                                    formatExportSize(warnedState.warning.estimatedBytes),
                                    grouped(warnedState.warning.limit),
                                ),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
                sessionExportErrorText(state)?.let { error ->
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        shape = RoundedCornerShape(8.dp),
                    ) {
                        Text(
                            text = error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !exporting && !ready,
                onClick = { controller.requestExport(SessionExportOutlet.SAVE) },
            ) {
                Text(
                    stringResource(
                        when {
                            exporting -> R.string.session_export_progress
                            warned -> R.string.session_export_save_anyway
                            else -> R.string.session_export_save
                        },
                    ),
                )
            }
        },
        dismissButton = {
            Row {
                TextButton(
                    enabled = !exporting && !ready,
                    onClick = { controller.requestExport(SessionExportOutlet.SHARE) },
                ) {
                    Text(
                        stringResource(
                            if (warned) {
                                R.string.session_export_share_anyway
                            } else {
                                R.string.session_export_share
                            },
                        ),
                    )
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.sessions_cancel))
                }
            }
        },
    )
}

/** Maps the terminal states to their message; null when there is no error box. */
@Composable
private fun sessionExportErrorText(state: SessionExportUiState): String? = when (state) {
    is SessionExportUiState.TooLarge -> stringResource(
        R.string.session_export_error_too_large,
        grouped(state.count),
        formatExportSize(state.estimatedBytes),
        formatExportSize(state.maxBytes),
    )
    is SessionExportUiState.Failed -> when (val failure = state.failure) {
        is SessionExportFailure.Write -> stringResource(R.string.session_export_error_write)
        is SessionExportFailure.Transport ->
            failure.error.message?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.session_export_error_default)
    }
    else -> null
}

@Composable
private fun SessionExportFormatOption(
    title: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onSelect: () -> Unit,
) {
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.secondaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (selected) {
            MaterialTheme.colorScheme.onSecondaryContainer
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        shape = RoundedCornerShape(8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled, onClick = onSelect)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, enabled = enabled, onClick = onSelect)
            Spacer(modifier = Modifier.width(8.dp))
            Column {
                Text(text = title, style = MaterialTheme.typography.bodyMedium)
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

// -------------------------------------------------------------- preview --

@Preview
@Composable
private fun SessionExportDialogPreview() {
    HapiTheme {
        SessionExportDialog(
            sessionId = "fixture-session-id",
            support = SessionExportSupport(
                fetcher = { _, _ ->
                    app.hapi.protocol.wire.SessionExportResponse.Warning(
                        app.hapi.protocol.wire.SessionExportWarning(
                            count = 21_000,
                            limit = 20_000,
                            estimatedBytes = 12_345_678,
                        ),
                    )
                },
                formatStore = object : SessionExportFormatStore {
                    override suspend fun read(): SessionExportFormat = SessionExportFormat.JSON
                    override suspend fun write(format: SessionExportFormat) = Unit
                },
            ),
            onDismiss = {},
        )
    }
}

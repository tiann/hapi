package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentUi
import app.hapi.companion.feature.chat.attachments.rememberChipThumbnail
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.wire.SlashCommand
import kotlinx.coroutines.delay

/**
 * The chat input card (B-M3a, extended in B-M3ce/B-M3f): attachments and the
 * multiline text field grow above a fixed bottom action row. The trailing
 * primary action is stateful: Stop while a turn runs with an empty draft,
 * otherwise Send (long-press offers "Send & steer" during a turn). The card
 * also hosts dictation and attachment controls, while slash suggestions stay
 * outside so the popup cannot be clipped by the rounded surface.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatComposer(
    state: ComposerUiState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onSendSteer: () -> Unit,
    onAbort: () -> Unit,
    modifier: Modifier = Modifier,
    attachments: List<ComposerAttachmentUi> = emptyList(),
    onAddAttachment: (() -> Unit)? = null,
    onAttachmentRetry: (String) -> Unit = {},
    onAttachmentRemove: (String) -> Unit = {},
    slashSuggestions: List<SlashCommand> = emptyList(),
    onSlashCommandSelected: (SlashCommand) -> Unit = {},
    /** null ⇒ dictation unavailable (no controller wired) — mic button hidden. */
    dictation: DictationState? = null,
    onDictationToggle: () -> Unit = {},
    onDictationCancel: () -> Unit = {},
) {
    Surface(color = MaterialTheme.colorScheme.surface, modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            if (slashSuggestions.isNotEmpty()) {
                SlashCommandDropdown(
                    suggestions = slashSuggestions,
                    onSelect = onSlashCommandSelected,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                shape = RoundedCornerShape(20.dp),
                tonalElevation = 1.dp,
                shadowElevation = 2.dp,
                border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column {
                    if (attachments.isNotEmpty()) {
                        LazyRow(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 2.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            items(attachments, key = { it.id }) { attachment ->
                                ComposerAttachmentChip(
                                    attachment = attachment,
                                    onRetry = { onAttachmentRetry(attachment.id) },
                                    onRemove = { onAttachmentRemove(attachment.id) },
                                )
                            }
                        }
                    }
                    val recording = dictation as? DictationState.Recording
                    if (recording != null) {
                        RecordingChip(
                            startedAtMs = recording.startedAtMs,
                            onCancel = onDictationCancel,
                            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 2.dp),
                        )
                    }
                    BasicTextField(
                        value = state.text,
                        onValueChange = onTextChange,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(
                            color = MaterialTheme.colorScheme.onSurface,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        maxLines = 6,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp),
                        decorationBox = { inner ->
                            Box {
                                if (state.text.isEmpty()) {
                                    Text(
                                        text = stringResource(R.string.chat_composer_placeholder),
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.hapi.hint,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            // 48 dp touch slot with a centered 38 dp circle:
                            // 7 + 5 = the shared 12 dp visual inset.
                            .padding(start = 7.dp, end = 7.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (onAddAttachment != null) {
                            ComposerActionButton(
                                contentDescription = stringResource(R.string.chat_composer_add_attachment),
                                onClick = onAddAttachment,
                            ) {
                                Icon(PlusGlyph, contentDescription = null, modifier = Modifier.size(20.dp))
                            }
                        }
                        Spacer(modifier = Modifier.weight(1f))
                        if (dictation != null) {
                            MicButton(state = dictation, onToggle = onDictationToggle)
                        }
                        PrimaryActionButton(
                            state = state,
                            attachments = attachments,
                            onSend = onSend,
                            onSendSteer = onSendSteer,
                            onAbort = onAbort,
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------- attachments --

/**
 * One tray chip: 36 dp thumb (image preview / MIME glyph, spinner while
 * uploading), filename + status line, ✕ to remove. A failed chip tints error
 * and taps to retry.
 */
@Composable
private fun ComposerAttachmentChip(
    attachment: ComposerAttachmentUi,
    onRetry: () -> Unit,
    onRemove: () -> Unit,
) {
    val failed = attachment.status == ComposerAttachmentStatus.Failed
    Surface(
        color = if (failed) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (failed) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        shape = RoundedCornerShape(10.dp),
        onClick = { if (failed) onRetry() },
        enabled = failed,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 6.dp, top = 6.dp, bottom = 6.dp),
        ) {
            ChipThumb(attachment)
            Column(modifier = Modifier.padding(start = 8.dp).widthIn(max = 132.dp)) {
                Text(
                    text = attachment.filename,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = when (attachment.status) {
                        ComposerAttachmentStatus.Uploading -> stringResource(R.string.chat_attachment_uploading)
                        ComposerAttachmentStatus.Failed -> stringResource(R.string.chat_attachment_failed_retry)
                        ComposerAttachmentStatus.Ready -> formatChipSize(attachment.sizeBytes)
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.hapi.hint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = "✕",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable(onClick = onRemove)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun ChipThumb(attachment: ComposerAttachmentUi) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(8.dp)),
    ) {
        val thumbnail = rememberChipThumbnail(attachment.previewBytes)
        if (thumbnail != null) {
            Image(
                bitmap = thumbnail,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(36.dp)
                    .graphicsLayer {
                        alpha = if (attachment.status == ComposerAttachmentStatus.Uploading) 0.4f else 1f
                    },
            )
        } else {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.size(36.dp)) {}
            Text(text = if (attachment.mimeType.startsWith("image/")) "🖼" else "📎", fontSize = 15.sp)
        }
        if (attachment.status == ComposerAttachmentStatus.Uploading) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        }
    }
}

/** `12.3 MB` / `456 KB` / `789 B` chip size label. */
internal fun formatChipSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

/** Shared 48 dp touch target with a centered 38 dp visual circle. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerActionButton(
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.surfaceContainerHigh,
    contentColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .combinedClickable(
                enabled = enabled,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .semantics(mergeDescendants = true) {
                this.contentDescription = contentDescription
                role = Role.Button
                if (!enabled) disabled()
            },
    ) {
        Surface(
            color = color,
            contentColor = contentColor,
            shape = CircleShape,
            modifier = Modifier.size(38.dp),
        ) {
            Box(contentAlignment = Alignment.Center) { content() }
        }
    }
}

// -------------------------------------------------------- slash dropdown --

/**
 * Filtered command list above the input (web `Autocomplete.tsx` twin):
 * name + description rows, tap inserts `/name `.
 */
@Composable
private fun SlashCommandDropdown(
    suggestions: List<SlashCommand>,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(12.dp),
        tonalElevation = 2.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        LazyColumn(modifier = Modifier.heightIn(max = 240.dp)) {
            items(suggestions, key = { "${it.source}:${it.name}" }) { command ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .combinedClickable(onClick = { onSelect(command) })
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = "/${command.name}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    command.description?.takeIf { it.isNotBlank() }?.let { description ->
                        Text(
                            text = description,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.hapi.hint,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.surfaceContainerHighest)
            }
        }
    }
}

// ------------------------------------------------------------- dictation --

/** Elapsed-time recording chip with a cancel affordance (discards the take). */
@Composable
private fun RecordingChip(
    startedAtMs: Long,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    /** Injectable clock for previews. */
    now: () -> Long = System::currentTimeMillis,
) {
    var elapsedSec by remember(startedAtMs) {
        mutableLongStateOf(((now() - startedAtMs) / 1000).coerceAtLeast(0))
    }
    LaunchedEffect(startedAtMs) {
        while (true) {
            elapsedSec = ((now() - startedAtMs) / 1000).coerceAtLeast(0)
            delay(250)
        }
    }
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_recording, formatElapsed(elapsedSec)),
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
            )
            TextButton(onClick = onCancel) { Text(stringResource(R.string.chat_cancel)) }
        }
    }
}

/** `m:ss` elapsed-time label for the recording chip. */
internal fun formatElapsed(totalSeconds: Long): String {
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "%d:%02d".format(minutes, seconds)
}

/**
 * Press-to-toggle mic: idle glyph → recording stop-square (error colors) →
 * spinner while starting/transcribing.
 */
@Composable
private fun MicButton(state: DictationState, onToggle: () -> Unit) {
    val recording = state is DictationState.Recording
    val busy = state is DictationState.Starting || state is DictationState.Transcribing
    ComposerActionButton(
        contentDescription = stringResource(
            if (recording) R.string.chat_composer_stop_recording else R.string.chat_composer_mic,
        ),
        onClick = onToggle,
        enabled = !busy,
        color = if (recording) {
            MaterialTheme.colorScheme.errorContainer
        } else {
            MaterialTheme.colorScheme.surfaceContainerHigh
        },
        contentColor = if (recording) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    ) {
        when {
            busy -> CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.hapi.hint,
            )
            recording -> Icon(StopGlyph, contentDescription = null, modifier = Modifier.size(18.dp))
            else -> Icon(MicGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
        }
    }
}

// ---------------------------------------------------------------- actions --

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PrimaryActionButton(
    state: ComposerUiState,
    attachments: List<ComposerAttachmentUi>,
    onSend: () -> Unit,
    onSendSteer: () -> Unit,
    onAbort: () -> Unit,
) {
    var steerMenuOpen by remember { mutableStateOf(false) }
    val hasText = state.text.isNotBlank()
    val hasDraft = hasText || attachments.isNotEmpty()
    // Attachments gate the send like the web: every chip must settle Ready
    // (uploading waits, failed must be retried or removed); a ready tray
    // allows an attachments-only send (wire: text or attachments required).
    val attachmentsBusy = attachments.any { it.status != ComposerAttachmentStatus.Ready }
    val attachmentsReady = attachments.isNotEmpty() && !attachmentsBusy
    val canSubmit = (hasText || attachmentsReady) && !attachmentsBusy && !state.isSending
    val action = when {
        state.isSending -> ComposerPrimaryAction.Sending
        state.canSteer && !hasDraft -> ComposerPrimaryAction.Stop
        else -> ComposerPrimaryAction.Send
    }

    Box {
        when (action) {
            ComposerPrimaryAction.Sending -> ComposerActionButton(
                contentDescription = stringResource(R.string.chat_composer_send),
                onClick = {},
                enabled = false,
                contentColor = MaterialTheme.hapi.hint,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.hapi.hint,
                )
            }
            ComposerPrimaryAction.Stop -> ComposerActionButton(
                contentDescription = stringResource(R.string.chat_composer_abort),
                onClick = onAbort,
                color = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ) {
                Icon(StopGlyph, contentDescription = null, modifier = Modifier.size(19.dp))
            }
            ComposerPrimaryAction.Send -> ComposerActionButton(
                contentDescription = stringResource(R.string.chat_composer_send),
                onClick = onSend,
                onLongClick = if (state.canSteer && canSubmit) {
                    { steerMenuOpen = true }
                } else {
                    null
                },
                enabled = canSubmit,
                color = if (canSubmit) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHigh
                },
                contentColor = if (canSubmit) {
                    MaterialTheme.colorScheme.onPrimary
                } else {
                    MaterialTheme.hapi.hint
                },
            ) {
                Icon(ArrowUpGlyph, contentDescription = null, modifier = Modifier.size(20.dp))
            }
        }
        if (action == ComposerPrimaryAction.Send) {
            DropdownMenu(expanded = steerMenuOpen, onDismissRequest = { steerMenuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_send_steer)) },
                    onClick = {
                        steerMenuOpen = false
                        onSendSteer()
                    },
                )
            }
        }
    }
}

private enum class ComposerPrimaryAction {
    Sending,
    Stop,
    Send,
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun ChatComposerPreview() {
    HapiTheme {
        Surface {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = false),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = true),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(
                        text = "Run the tests and summarize failures\nThen propose the smallest safe fix.",
                        isSending = false,
                        canSteer = true,
                    ),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "Sending…", isSending = true, canSteer = false),
                    onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    attachments = listOf(
                        ComposerAttachmentUi(
                            id = "a1",
                            filename = "screenshot.png",
                            mimeType = "image/png",
                            sizeBytes = 1_843_200,
                            previewBytes = null,
                            status = ComposerAttachmentStatus.Ready,
                        ),
                    ),
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AttachmentChipsComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "", isSending = false, canSteer = true),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                onAddAttachment = {},
                attachments = listOf(
                    ComposerAttachmentUi(
                        id = "up",
                        filename = "IMG_20260818_133702.jpg",
                        mimeType = "image/jpeg",
                        sizeBytes = 2_411_000,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Uploading,
                    ),
                    ComposerAttachmentUi(
                        id = "ok",
                        filename = "build-log.txt",
                        mimeType = "text/plain",
                        sizeBytes = 48_500,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Ready,
                    ),
                    ComposerAttachmentUi(
                        id = "bad",
                        filename = "trace.bin",
                        mimeType = "application/octet-stream",
                        sizeBytes = 9_000_000,
                        previewBytes = null,
                        status = ComposerAttachmentStatus.Failed,
                    ),
                ),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun RecordingComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "", isSending = false, canSteer = false),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Recording(startedAtMs = System.currentTimeMillis() - 42_000),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SlashDropdownComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "/co", isSending = false, canSteer = false),
                onTextChange = {}, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Idle,
                slashSuggestions = listOf(
                    SlashCommand(
                        name = "compact",
                        description = "Clear conversation history but keep a summary in context",
                        source = "builtin",
                    ),
                    SlashCommand(
                        name = "context",
                        description = "Visualize current context usage as a colored grid",
                        source = "builtin",
                    ),
                    SlashCommand(name = "code-review", description = null, source = "project"),
                ),
            )
        }
    }
}

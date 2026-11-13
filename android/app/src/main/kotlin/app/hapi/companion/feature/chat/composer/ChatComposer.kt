package app.hapi.companion.feature.chat.composer

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.components.softShadow
import app.hapi.companion.feature.chat.ComposerUiState
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerAttachmentUi
import app.hapi.companion.feature.chat.attachments.rememberChipThumbnail
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.wire.SlashCommand
import kotlinx.coroutines.delay

/**
 * The chat input card (B-M3a, extended in B-M3ce/B-M3f/B-M16b; iOS
 * `ChatComposerView` parity). Resting — empty, unfocused, nothing pending —
 * it is one row: +, the field and the primary action. Focus, a draft, chips,
 * a schedule, an open picker or a recording expand it to the field above a
 * tool row; the field is one instance in both shapes, so focus survives.
 *
 * Tools are bare 20dp symbols whose state is color only; the trailing primary
 * action is the single filled shape: Stop while a turn runs with an empty
 * draft, otherwise Send (long-press offers "Send & steer" during a turn;
 * Ctrl/⌘+Enter sends from a hardware keyboard with the same gate). Slash /
 * mention suggestions stay outside the card so the popup is never clipped.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatComposer(
    state: ComposerUiState,
    /** User edit (text + live selection start/end) from the field's TextFieldValue, as one atomic report. */
    onTextChange: (String, Int, Int) -> Unit,
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
    /** `@word` mention rows (B-M16a); rendered when the slash dropdown is empty. */
    mentionSuggestions: List<MentionSuggestion> = emptyList(),
    onMentionSelected: (MentionSuggestion) -> Unit = {},
    /**
     * Pending scheduled-send pick (B-M16b); non-null tints the clock, shows the
     * "Scheduled · …" capsule (its × clears the pick), disables the attach
     * button (web `hasSchedule`) and makes the next Send resolve
     * `scheduledAt` at the send instant.
     */
    pendingSchedule: PendingSchedule? = null,
    onScheduleSelected: (PendingSchedule) -> Unit = {},
    onClearSchedule: () -> Unit = {},
    /** null ⇒ dictation unavailable (no controller wired) — mic button hidden. */
    dictation: DictationState? = null,
    onDictationToggle: () -> Unit = {},
    onDictationCancel: () -> Unit = {},
) {
    val focusRequester = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Do not replay an old focus intent when returning from an inspector.
    var handledFocusRequest by remember { mutableLongStateOf(state.focusRequest) }
    // Schedule panel toggle (B-M16b); opens fresh in the Relative tab each
    // time because the picker composes only while open (web remounts too).
    var schedulePickerOpen by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val hasSchedule = pendingSchedule != null
    // An open panel stays interactive while the tray fills (the clock button
    // alone only disables the *entry*): every pick in it would arm the
    // illegal schedule+attachments combo, so the panel closes the moment a
    // chip appears. The ViewModel rejects the transition regardless — this
    // keeps the UI from offering it.
    LaunchedEffect(attachments.isNotEmpty()) {
        if (attachments.isNotEmpty()) schedulePickerOpen = false
    }
    LaunchedEffect(state.focusRequest) {
        if (state.focusRequest != handledFocusRequest) {
            handledFocusRequest = state.focusRequest
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
    // The field owns the caret; the text stays VM-driven (draft prefill,
    // send-clear, slash/mention inserts). External text edits adopt the VM's
    // resting caret ([ComposerUiState.caretPosition] — a mention insert lands
    // mid-draft, other programmatic sets rest at the tail); user edits and
    // caret moves never adopt, so typing mid-draft keeps its position.
    var field by remember { mutableStateOf(TextFieldValue(state.text)) }
    LaunchedEffect(state.text) {
        if (field.text != state.text) {
            val caret = if (state.caretPosition >= 0) {
                state.caretPosition.coerceIn(0, state.text.length)
            } else {
                state.text.length
            }
            field = TextFieldValue(state.text, TextRange(caret))
        }
    }
    val gate = composerSendGate(state, attachments)
    val recording = dictation as? DictationState.Recording
    val dictationBusy = dictation is DictationState.Starting || dictation is DictationState.Transcribing
    val collapsed = !focused && state.text.isEmpty() && attachments.isEmpty() && !hasSchedule &&
        !schedulePickerOpen && recording == null && !dictationBusy && !state.isImportingShare
    val composerSurface = MaterialTheme.hapi.composerSurface

    // Opaque strip, deliberately not a Surface: Surface clips its content, which
    // cut the card's and popups' soft shadows into a hard top edge.
    Box(modifier = modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.padding(top = 6.dp, bottom = 8.dp)) {
            if (slashSuggestions.isNotEmpty()) {
                SlashCommandDropdown(
                    suggestions = slashSuggestions,
                    onSelect = onSlashCommandSelected,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            } else if (mentionSuggestions.isNotEmpty()) {
                MentionDropdown(
                    suggestions = mentionSuggestions,
                    onSelect = onMentionSelected,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
            }
            if (schedulePickerOpen) {
                ScheduleTimePicker(
                    pendingSchedule = pendingSchedule,
                    onSchedule = {
                        schedulePickerOpen = false
                        onScheduleSelected(it)
                    },
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            val dark = MaterialTheme.hapi.isDark
            Surface(
                color = composerSurface,
                shape = ComposerCardShape,
                border = BorderStroke(0.5.dp, MaterialTheme.hapi.divider),
                // iOS: black 8%, 8pt blur, 2pt down. Dark relies on the lighter fill.
                modifier = Modifier
                    .fillMaxWidth()
                    .then(if (dark) Modifier else Modifier.drawWithCache { softShadow(composerSurface, ComposerCornerRadius) }),
            ) {
                Column(Modifier.animateContentSize()) {
                    if (state.isImportingShare) {
                        Text(
                            stringResource(R.string.share_importing),
                            style = HapiTypography.caption,
                            color = MaterialTheme.hapi.textSecondary,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
                        )
                    }
                    if (attachments.isNotEmpty()) {
                        LazyRow(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = 10.dp, end = 10.dp, top = 10.dp),
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
                    if (pendingSchedule != null) {
                        ScheduleCapsule(
                            pending = pendingSchedule,
                            onClear = {
                                schedulePickerOpen = false
                                onClearSchedule()
                            },
                            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
                        )
                    }
                    if (recording != null) {
                        RecordingChip(
                            startedAtMs = recording.startedAtMs,
                            onCancel = onDictationCancel,
                            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 10.dp),
                        )
                    }
                    Row(verticalAlignment = Alignment.Bottom) {
                        if (collapsed && onAddAttachment != null) {
                            ComposerToolButton(
                                iconRes = R.drawable.ic_sym_add,
                                contentDescription = stringResource(R.string.chat_composer_add_attachment),
                                onClick = onAddAttachment,
                                modifier = Modifier.padding(start = 2.dp),
                            )
                        }
                        // One field instance in both shapes: focusing the
                        // resting row expands the card without losing focus.
                        BasicTextField(
                            value = field,
                            enabled = !state.isImportingShare,
                            onValueChange = { value ->
                                field = value
                                onTextChange(value.text, value.selection.start, value.selection.end)
                            },
                            textStyle = HapiTypography.body.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            maxLines = 6,
                            modifier = Modifier
                                .weight(1f)
                                .focusRequester(focusRequester)
                                .onFocusChanged { focused = it.isFocused }
                                .onPreviewKeyEvent { event ->
                                    val submit = event.key == Key.Enter && (event.isCtrlPressed || event.isMetaPressed)
                                    if (!submit) return@onPreviewKeyEvent false
                                    // Consume both edges so no newline lands; act on key-down only.
                                    if (event.type == KeyEventType.KeyDown && gate.action == ComposerPrimaryAction.Send && gate.canSubmit) {
                                        onSend()
                                    }
                                    true
                                }
                                .testTag("chat-composer-input")
                                .padding(
                                    start = if (collapsed && onAddAttachment != null) 2.dp else 16.dp,
                                    end = if (collapsed) 4.dp else 16.dp,
                                    top = if (collapsed) 13.dp else 14.dp,
                                    bottom = if (collapsed) 13.dp else 6.dp,
                                ),
                            decorationBox = { inner ->
                                Box {
                                    if (state.text.isEmpty()) {
                                        Text(
                                            text = stringResource(R.string.chat_composer_placeholder),
                                            style = HapiTypography.body,
                                            color = MaterialTheme.hapi.hint,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    inner()
                                }
                            },
                        )
                        if (collapsed) {
                            PrimaryActionButton(
                                state = state,
                                gate = gate,
                                onSend = onSend,
                                onSendSteer = onSendSteer,
                                onAbort = onAbort,
                                modifier = Modifier.padding(end = 3.dp),
                            )
                        }
                    }
                    if (!collapsed) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = 2.dp, end = 3.dp, bottom = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (onAddAttachment != null) {
                                ComposerToolButton(
                                    iconRes = R.drawable.ic_sym_add,
                                    contentDescription = stringResource(R.string.chat_composer_add_attachment),
                                    onClick = onAddAttachment,
                                    // web: attachments and a schedule are mutually
                                    // exclusive (`disabled={controlsDisabled || hasSchedule}`).
                                    enabled = !hasSchedule,
                                )
                            }
                            // Clock (B-M16b, web ComposerButtons schedule slot):
                            // toggles the picker; a pending pick only tints it —
                            // clearing is the capsule's ×, never a silent tap.
                            // Disabled while sending or with attachments on the
                            // tray (web `controlsDisabled || hasAttachments`).
                            ComposerToolButton(
                                iconRes = R.drawable.ic_sym_schedule,
                                contentDescription = stringResource(R.string.chat_schedule_send),
                                onClick = { schedulePickerOpen = !schedulePickerOpen },
                                enabled = !state.isSending && attachments.isEmpty(),
                                tint = if (hasSchedule || schedulePickerOpen) MaterialTheme.colorScheme.primary else null,
                            )
                            if (dictation != null) {
                                MicButton(state = dictation, onToggle = onDictationToggle)
                            }
                            Spacer(modifier = Modifier.weight(1f))
                            PrimaryActionButton(
                                state = state,
                                gate = gate,
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
}

private val ComposerCornerRadius = 22.dp
private val ComposerCardShape = RoundedCornerShape(ComposerCornerRadius)

// ------------------------------------------------------------- send gate --

internal enum class ComposerPrimaryAction {
    Sending,
    Stop,
    Send,
}

/** What the primary action shows and whether Send may fire (button and Ctrl/⌘+Enter share it). */
internal data class ComposerSendGate(val action: ComposerPrimaryAction, val canSubmit: Boolean)

internal fun composerSendGate(state: ComposerUiState, attachments: List<ComposerAttachmentUi>): ComposerSendGate {
    val hasText = state.text.isNotBlank()
    val hasDraft = hasText || attachments.isNotEmpty()
    // Attachments gate the send like the web: every chip must settle Ready
    // (uploading waits, failed must be retried or removed); a ready tray
    // allows an attachments-only send (wire: text or attachments required).
    val attachmentsBusy = attachments.any { it.status != ComposerAttachmentStatus.Ready }
    val attachmentsReady = attachments.isNotEmpty() && !attachmentsBusy
    val canSubmit = (hasText || attachmentsReady) && !attachmentsBusy && !state.isSending && !state.isImportingShare
    val action = when {
        state.isSending || state.isImportingShare -> ComposerPrimaryAction.Sending
        state.canSteer && !hasDraft -> ComposerPrimaryAction.Stop
        else -> ComposerPrimaryAction.Send
    }
    return ComposerSendGate(action, canSubmit)
}

// ---------------------------------------------------------- attachments --

/**
 * One tray chip: 36 dp thumb (image preview / MIME symbol, spinner while
 * uploading), filename + status line, × to remove. A failed chip tints error
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
            MaterialTheme.hapi.cardSurface
        },
        contentColor = if (failed) {
            MaterialTheme.colorScheme.onErrorContainer
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        shape = RoundedCornerShape(12.dp),
        border = if (failed) null else BorderStroke(0.5.dp, MaterialTheme.hapi.divider),
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
                    style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium),
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
                Text(
                    text = when (attachment.status) {
                        ComposerAttachmentStatus.Uploading -> stringResource(R.string.chat_attachment_uploading)
                        ComposerAttachmentStatus.Failed -> stringResource(R.string.chat_attachment_failed_retry)
                        ComposerAttachmentStatus.Ready -> formatChipSize(attachment.sizeBytes)
                    },
                    style = HapiTypography.caption,
                    color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.hapi.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            ComposerToolButton(
                iconRes = R.drawable.ic_sym_close,
                contentDescription = stringResource(R.string.chat_attachment_remove, attachment.filename),
                onClick = onRemove,
                iconSize = 16.dp,
                slotSize = 40.dp,
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
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
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
            Icon(
                painter = painterResource(
                    if (attachment.mimeType.startsWith("image/")) R.drawable.ic_sym_image else R.drawable.ic_sym_attach_file,
                ),
                contentDescription = null,
                tint = MaterialTheme.hapi.textSecondary,
                modifier = Modifier.size(18.dp),
            )
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

// ------------------------------------------------------------- schedule --

/**
 * Pending scheduled-send capsule (iOS "Scheduled · In 30 minutes"): presets
 * keep their raw web labels (`+30m`, resolved at the Send tap), absolute
 * picks show the web `formatScheduledTime` text. × clears the pick.
 */
@Composable
private fun ScheduleCapsule(pending: PendingSchedule, onClear: () -> Unit, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val whenLabel = when (pending) {
        is PendingSchedule.Preset -> pending.preset
        is PendingSchedule.Absolute -> ScheduleSend.formatScheduledTime(pending.ms)
    }
    Surface(
        color = accent.copy(alpha = 0.12f),
        contentColor = accent,
        shape = CircleShape,
        modifier = modifier.testTag("chat-schedule-capsule"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 10.dp)) {
            Icon(painterResource(R.drawable.ic_sym_schedule), contentDescription = null, modifier = Modifier.size(14.dp))
            Text(
                text = stringResource(R.string.chat_schedule_capsule, whenLabel),
                style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 6.dp),
            )
            ComposerToolButton(
                iconRes = R.drawable.ic_sym_close,
                contentDescription = stringResource(R.string.chat_schedule_clear),
                onClick = onClear,
                iconSize = 14.dp,
                slotSize = 32.dp,
                tint = accent,
            )
        }
    }
}

// ---------------------------------------------------------------- buttons --

/**
 * A bare tool symbol (iOS 20pt SF Symbol in a 44pt slot): no disc, state is
 * tint only. The slot keeps Android's 48dp target.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerToolButton(
    iconRes: Int,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color? = null,
    iconSize: Dp = 22.dp,
    slotSize: Dp = 48.dp,
) {
    val base = tint ?: MaterialTheme.hapi.textSecondary
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(slotSize)
            .clip(CircleShape)
            .combinedClickable(enabled = enabled, onClick = onClick)
            .semantics(mergeDescendants = true) {
                this.contentDescription = contentDescription
                role = Role.Button
                if (!enabled) disabled()
            },
    ) {
        Icon(
            painter = painterResource(iconRes),
            contentDescription = null,
            tint = if (enabled) base else base.copy(alpha = 0.38f),
            modifier = Modifier.size(iconSize),
        )
    }
}

/** The composer's one filled shape: a 34dp circle centered in a 48dp slot. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ComposerFilledButton(
    contentDescription: String,
    onClick: () -> Unit,
    color: Color,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(48.dp)
            .clip(CircleShape)
            .combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick)
            .semantics(mergeDescendants = true) {
                this.contentDescription = contentDescription
                role = Role.Button
                if (!enabled) disabled()
            },
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(34.dp)
                .clip(CircleShape)
                .background(color),
        ) { content() }
    }
}

// -------------------------------------------------------- slash dropdown --

private val PopupShape = RoundedCornerShape(16.dp)

/** Suggestion popup chrome (iOS: composer surface, 16pt corners, soft shadow). */
@Composable
private fun SuggestionPopup(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val fill = MaterialTheme.hapi.composerSurface
    Surface(
        color = fill,
        shape = PopupShape,
        border = BorderStroke(0.5.dp, MaterialTheme.hapi.divider),
        // iOS popup: black 6%, 6pt blur, 2pt down.
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (MaterialTheme.hapi.isDark) Modifier
                else Modifier.drawWithCache { softShadow(fill, 16.dp, Color.Black.copy(alpha = 0.06f), blur = 6.dp) },
            ),
        content = content,
    )
}

/**
 * Filtered command list above the input (web `Autocomplete.tsx` twin):
 * monospaced name + description rows, tap inserts `/name `.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SlashCommandDropdown(
    suggestions: List<SlashCommand>,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    SuggestionPopup(modifier) {
        LazyColumn(modifier = Modifier.heightIn(max = 232.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
            itemsIndexed(suggestions, key = { _, command -> "${command.source}:${command.name}" }) { index, command ->
                if (index > 0) HorizontalDivider(color = MaterialTheme.hapi.divider, modifier = Modifier.padding(start = 16.dp))
                Column(
                    verticalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .combinedClickable(onClick = { onSelect(command) })
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        text = "/${command.name}",
                        style = HapiTypography.code.copy(fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurface),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    command.description?.takeIf { it.isNotBlank() }?.let { description ->
                        Text(
                            text = description,
                            style = HapiTypography.rowSubtitle,
                            color = MaterialTheme.hapi.textSecondary,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

// -------------------------------------------------------- mention dropdown --

/**
 * `@` mention rows above the input (B-M16a, web `Autocomplete.tsx` twin):
 * session chips (`@<title>` + `Session · <id8> [· active]`) ahead of file hits
 * (`@<fileName>` + path); tap swaps the active word for the insert text.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MentionDropdown(
    suggestions: List<MentionSuggestion>,
    onSelect: (MentionSuggestion) -> Unit,
    modifier: Modifier = Modifier,
) {
    val mentionSuggestionsDescription = stringResource(R.string.chat_mention_suggestions)
    SuggestionPopup(modifier.semantics { contentDescription = mentionSuggestionsDescription }) {
        LazyColumn(modifier = Modifier.heightIn(max = 240.dp), contentPadding = PaddingValues(vertical = 4.dp)) {
            itemsIndexed(suggestions, key = { _, suggestion -> suggestion.key }) { index, suggestion ->
                if (index > 0) HorizontalDivider(color = MaterialTheme.hapi.divider, modifier = Modifier.padding(start = 50.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .combinedClickable(onClick = { onSelect(suggestion) })
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Icon(
                        painter = painterResource(
                            if (suggestion is MentionSuggestion.SessionMention) R.drawable.ic_sym_chat_bubble else R.drawable.ic_sym_description,
                        ),
                        contentDescription = null,
                        tint = MaterialTheme.hapi.textSecondary,
                        modifier = Modifier.size(20.dp),
                    )
                    Column(modifier = Modifier.padding(start = 14.dp)) {
                        Text(
                            text = suggestion.label,
                            style = HapiTypography.rowTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = suggestion.description,
                            style = HapiTypography.rowSubtitle,
                            color = MaterialTheme.hapi.textSecondary,
                            maxLines = 1,
                            overflow = TextOverflow.MiddleEllipsis,
                        )
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------- dictation --

/** Elapsed-time recording strip with a cancel affordance (discards the take). */
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
    val error = MaterialTheme.colorScheme.error
    Surface(
        color = error.copy(alpha = 0.10f),
        contentColor = error,
        shape = RoundedCornerShape(12.dp),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_recording, formatElapsed(elapsedSec)),
                style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium),
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 12.dp),
            )
            TextButton(
                onClick = onCancel,
                contentPadding = PaddingValues(horizontal = 12.dp),
                modifier = Modifier.heightIn(min = 36.dp).defaultMinSize(minHeight = 36.dp),
            ) { Text(stringResource(R.string.chat_cancel), color = error, style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium)) }
        }
    }
}

/** `m:ss` elapsed-time label for the recording chip. */
internal fun formatElapsed(totalSeconds: Long): String {
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "%d:%02d".format(minutes, seconds)
}

/** Press-to-toggle mic: tint-only states (recording = error), spinner while starting/transcribing. */
@Composable
private fun MicButton(state: DictationState, onToggle: () -> Unit) {
    val recording = state is DictationState.Recording
    val busy = state is DictationState.Starting || state is DictationState.Transcribing
    if (busy) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.size(48.dp)) {
            CircularProgressIndicator(
                modifier = Modifier.size(18.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.hapi.textSecondary,
            )
        }
        return
    }
    ComposerToolButton(
        iconRes = R.drawable.ic_sym_mic,
        contentDescription = stringResource(
            if (recording) R.string.chat_composer_stop_recording else R.string.chat_composer_mic,
        ),
        onClick = onToggle,
        tint = if (recording) MaterialTheme.colorScheme.error else null,
    )
}

// ---------------------------------------------------------------- actions --

@Composable
private fun PrimaryActionButton(
    state: ComposerUiState,
    gate: ComposerSendGate,
    onSend: () -> Unit,
    onSendSteer: () -> Unit,
    onAbort: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var steerMenuOpen by remember { mutableStateOf(false) }
    val canSubmit = gate.canSubmit
    Box(modifier) {
        when (gate.action) {
            ComposerPrimaryAction.Sending -> {
                val sendLabel = stringResource(R.string.chat_composer_send)
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(48.dp)
                        .semantics {
                            contentDescription = sendLabel
                            role = Role.Button
                            disabled()
                        },
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.hapi.textSecondary,
                    )
                }
            }
            ComposerPrimaryAction.Stop -> ComposerFilledButton(
                contentDescription = stringResource(R.string.chat_composer_abort),
                onClick = onAbort,
                // Accent, not alarm red: stopping a turn is routine.
                color = MaterialTheme.colorScheme.primary,
            ) {
                Icon(
                    painterResource(R.drawable.ic_sym_stop_filled),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier.size(18.dp),
                )
            }
            ComposerPrimaryAction.Send -> ComposerFilledButton(
                contentDescription = stringResource(R.string.chat_composer_send),
                onClick = onSend,
                onLongClick = if (state.canSteer && canSubmit) {
                    { steerMenuOpen = true }
                } else {
                    null
                },
                enabled = canSubmit,
                color = if (canSubmit) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest,
            ) {
                Icon(
                    painterResource(R.drawable.ic_sym_arrow_upward),
                    contentDescription = null,
                    tint = if (canSubmit) MaterialTheme.colorScheme.onPrimary else MaterialTheme.hapi.hint,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
        if (gate.action == ComposerPrimaryAction.Send) {
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

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun ChatComposerPreview() {
    HapiTheme {
        Surface {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = false),
                    onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "", isSending = false, canSteer = true),
                    onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                    onAddAttachment = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(
                        text = "Run the tests and summarize failures\nThen propose the smallest safe fix.",
                        isSending = false,
                        canSteer = true,
                    ),
                    onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                    dictation = DictationState.Idle,
                )
                ChatComposer(
                    state = ComposerUiState(text = "Sending…", isSending = true, canSteer = false),
                    onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
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
                onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
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
                onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
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
                onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
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

@Preview(showBackground = true)
@Composable
private fun MentionDropdownComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(text = "@ref", isSending = false, canSteer = false),
                onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                dictation = DictationState.Idle,
                mentionSuggestions = listOf(
                    MentionSuggestion.SessionMention(
                        id = "3f9d2c1b8e7a4d60",
                        title = "Refactor auth flow",
                        key = "session:3f9d2c1b8e7a4d60",
                        label = "@Refactor auth flow",
                        description = "Session · 3f9d2c1b",
                        insertText = "See session \"Refactor auth flow\" (/sessions/3f9d2c1b8e7a4d60) for context.",
                    ),
                    MentionSuggestion.FileMention(
                        key = "@docs/auth.md",
                        label = "@auth.md",
                        description = "docs/auth.md",
                        insertText = "@docs/auth.md",
                    ),
                ),
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ScheduledComposerPreview() {
    HapiTheme {
        Surface {
            ChatComposer(
                state = ComposerUiState(
                    text = "Wrap up the release notes and ping me",
                    isSending = false,
                    canSteer = false,
                ),
                onTextChange = { _, _, _ -> }, onSend = {}, onSendSteer = {}, onAbort = {},
                pendingSchedule = PendingSchedule.Preset("+30m"),
                onScheduleSelected = {},
                onClearSchedule = {},
                dictation = DictationState.Idle,
            )
        }
    }
}

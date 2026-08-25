package app.hapi.companion.feature.scratchlist

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import android.content.Context
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.localizedRelativeAge
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistEntry
import coil.ImageLoader
import coil.compose.AsyncImage

/**
 * Hub-scoped media plumbing for scratchlist attachments: the authed Coil
 * loader plus the attachment URL builder (both from `HubGraph`). Null loader
 * (previews, tests) degrades thumbnails to filename chips.
 */
data class ScratchlistMedia(
    val imageLoader: ImageLoader?,
    val attachmentUrl: (attachmentId: String) -> String?,
)

private fun isImageMime(mimeType: String): Boolean = mimeType.startsWith("image/")

/**
 * Per-session scratchlist workbench (B-M4d): notes/drafts parked until the
 * operator promotes them. Entry cards (text preview, age, attachment thumbs)
 * open an edit sheet; the FAB drafts a new note; "To composer" inserts an
 * entry's text into the chat composer (wired by Navigation to the chat
 * ViewModel below this route).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScratchlistScreen(
    viewModel: ScratchlistViewModel,
    media: ScratchlistMedia,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    /** null ⇒ the affordance is hidden (no chat composer below this route). */
    onSendToComposer: ((ScratchlistEntry) -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    val editorState by viewModel.editor.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var viewerAttachment by remember { mutableStateOf<ScratchlistAttachment?>(null) }

    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { viewModel.stop() }
    }

    val context = LocalContext.current
    LaunchedEffect(viewModel, context) {
        viewModel.events.collect { event ->
            when (event) {
                is ScratchlistEvent.Notice ->
                    snackbarHostState.showSnackbar(scratchlistNoticeText(context, event.notice))
            }
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.scratchlist_back))
                    }
                },
                title = {
                    Column {
                        Text(stringResource(R.string.scratchlist_title), style = MaterialTheme.typography.titleMedium)
                        Text(
                            text = when {
                                !state.isLoading && state.entries.isEmpty() ->
                                    stringResource(R.string.scratchlist_count_none)
                                state.entries.size == 1 -> stringResource(R.string.scratchlist_count_one)
                                else -> stringResource(R.string.scratchlist_count_many, state.entries.size)
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            FloatingActionButton(onClick = { viewModel.openEditor(null) }) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.scratchlist_new_note))
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (state.uploadsInFlight.isNotEmpty()) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            when {
                state.isLoading -> CenteredHint { CircularProgressIndicator() }
                state.loadFailed -> LoadFailed(onRetry = viewModel::retry)
                state.entries.isEmpty() -> EmptyScratchlist()
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.entries, key = { it.entryId }) { entry ->
                        ScratchlistEntryCard(
                            entry = entry,
                            media = media,
                            onOpen = { viewModel.openEditor(entry) },
                            onSendToComposer = onSendToComposer?.let { send -> { send(entry) } },
                            onOpenAttachment = { viewerAttachment = it },
                        )
                    }
                }
            }
        }
    }

    editorState?.let { editor ->
        ScratchlistEditorSheet(
            editor = editor,
            media = media,
            onDismiss = viewModel::dismissEditor,
            onTextChange = viewModel::setEditorText,
            onSave = viewModel::saveEditor,
            onDelete = editor.entryId?.let { id -> { viewModel.deleteEntry(id) } },
            onAddAttachment = viewModel::addAttachment,
            onRemoveAttachment = viewModel::removeAttachment,
            onOpenAttachment = { viewerAttachment = it },
        )
    }

    viewerAttachment?.let { attachment ->
        AttachmentViewerDialog(
            attachment = attachment,
            media = media,
            onDismiss = { viewerAttachment = null },
        )
    }
}

// ------------------------------------------------------------------- card --

@Composable
private fun ScratchlistEntryCard(
    entry: ScratchlistEntry,
    media: ScratchlistMedia,
    onOpen: () -> Unit,
    onSendToComposer: (() -> Unit)?,
    onOpenAttachment: (ScratchlistAttachment) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(14.dp),
        tonalElevation = 1.dp,
        onClick = onOpen,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
            if (entry.attachments.isNotEmpty()) {
                AttachmentStrip(
                    attachments = entry.attachments,
                    media = media,
                    thumbSize = 64.dp,
                    onOpenAttachment = onOpenAttachment,
                )
                Spacer(modifier = Modifier.height(6.dp))
            }
            if (entry.text.isNotBlank()) {
                Text(
                    text = entry.text,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                Text(
                    text = stringResource(R.string.scratchlist_attachment_only),
                    style = MaterialTheme.typography.bodyMedium,
                    fontStyle = FontStyle.Italic,
                    color = MaterialTheme.hapi.hint,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = localizedRelativeAge(entry.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                )
                Spacer(modifier = Modifier.weight(1f))
                if (onSendToComposer != null) {
                    TextButton(onClick = onSendToComposer) {
                        Text(stringResource(R.string.scratchlist_to_composer), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------ attachments --

/**
 * Horizontal thumbnails: images render through the authed Coil loader, other
 * mime types (pdf/text) and loader-less previews degrade to filename chips.
 */
@Composable
private fun AttachmentStrip(
    attachments: List<ScratchlistAttachment>,
    media: ScratchlistMedia,
    thumbSize: androidx.compose.ui.unit.Dp,
    onOpenAttachment: (ScratchlistAttachment) -> Unit,
    onRemoveAttachment: ((ScratchlistAttachment) -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        attachments.forEach { attachment ->
            AttachmentThumb(
                attachment = attachment,
                media = media,
                thumbSize = thumbSize,
                onOpen = { onOpenAttachment(attachment) },
                onRemove = onRemoveAttachment?.let { remove -> { remove(attachment) } },
            )
        }
    }
}

/** One thumbnail (image via Coil, otherwise a filename chip) with an optional ✕ badge. */
@Composable
private fun AttachmentThumb(
    attachment: ScratchlistAttachment,
    media: ScratchlistMedia,
    thumbSize: androidx.compose.ui.unit.Dp,
    onOpen: () -> Unit,
    onRemove: (() -> Unit)? = null,
) {
    val url = media.attachmentUrl(attachment.id)
    Box {
        if (media.imageLoader != null && url != null && isImageMime(attachment.mimeType)) {
            AsyncImage(
                model = url,
                imageLoader = media.imageLoader,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(thumbSize)
                    .clip(RoundedCornerShape(10.dp))
                    .clickable { onOpen() },
            )
        } else {
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.size(thumbSize),
                onClick = onOpen,
            ) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(4.dp)) {
                    Text(
                        text = "📎 ${attachment.filename}",
                        style = MaterialTheme.typography.labelSmall,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (onRemove != null) {
            Surface(
                color = MaterialTheme.colorScheme.inverseSurface,
                contentColor = MaterialTheme.colorScheme.inverseOnSurface,
                shape = CircleShape,
                onClick = onRemove,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(2.dp)
                    .size(20.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(text = "✕", fontSize = 11.sp)
                }
            }
        }
    }
}

// ----------------------------------------------------------------- editor --

/**
 * Edit sheet: text field + attachment strip (photo picker, remove, spinner
 * while a file imports/uploads) + Delete for existing entries + Save.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScratchlistEditorSheet(
    editor: ScratchlistEditorState,
    media: ScratchlistMedia,
    onDismiss: () -> Unit,
    onTextChange: (String) -> Unit,
    onSave: () -> Unit,
    onDelete: (() -> Unit)?,
    onAddAttachment: (android.net.Uri) -> Unit,
    onRemoveAttachment: (ScratchlistAttachment) -> Unit,
    onOpenAttachment: (ScratchlistAttachment) -> Unit,
) {
    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> uri?.let(onAddAttachment) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            Text(
                text = stringResource(
                    if (editor.entryId == null) R.string.scratchlist_new_note else R.string.scratchlist_edit_note,
                ),
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(modifier = Modifier.height(10.dp))
            OutlinedTextField(
                value = editor.text,
                onValueChange = onTextChange,
                placeholder = { Text(stringResource(R.string.scratchlist_placeholder)) },
                minLines = 3,
                maxLines = 8,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(10.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                editor.attachments.forEach { attachment ->
                    AttachmentThumb(
                        attachment = attachment,
                        media = media,
                        thumbSize = 72.dp,
                        onOpen = { onOpenAttachment(attachment) },
                        onRemove = { onRemoveAttachment(attachment) },
                    )
                }
                if (editor.isUploading) {
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.size(72.dp),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        }
                    }
                } else {
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceContainerHigh,
                        shape = RoundedCornerShape(10.dp),
                        onClick = {
                            pickImage.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                        modifier = Modifier.size(72.dp),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.scratchlist_add_photo))
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (onDelete != null) {
                    TextButton(onClick = onDelete) {
                        Text(stringResource(R.string.scratchlist_delete), color = MaterialTheme.colorScheme.error)
                    }
                }
                Spacer(modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.scratchlist_cancel)) }
                Spacer(modifier = Modifier.width(6.dp))
                Button(onClick = onSave, enabled = !editor.isUploading) {
                    Text(stringResource(R.string.scratchlist_save))
                }
            }
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

// ----------------------------------------------------------------- viewer --

/** Full-screen attachment viewer (the generated-image viewer pattern). */
@Composable
private fun AttachmentViewerDialog(
    attachment: ScratchlistAttachment,
    media: ScratchlistMedia,
    onDismiss: () -> Unit,
) {
    val url = media.attachmentUrl(attachment.id)
    if (media.imageLoader == null || url == null || !isImageMime(attachment.mimeType)) {
        onDismiss()
        return
    }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.92f))
                .clickable { onDismiss() },
            contentAlignment = Alignment.Center,
        ) {
            AsyncImage(
                model = url,
                imageLoader = media.imageLoader,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(8.dp),
            )
        }
    }
}

// ----------------------------------------------------------------- states --

@Composable
private fun CenteredHint(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        content()
    }
}

@Composable
private fun LoadFailed(onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.scratchlist_load_failed), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.scratchlist_check_connection),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(12.dp))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.scratchlist_retry)) }
    }
}

@Composable
private fun EmptyScratchlist() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = "🗒", fontSize = 34.sp)
        Spacer(modifier = Modifier.height(8.dp))
        Text(text = stringResource(R.string.scratchlist_empty_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.scratchlist_empty_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// -------------------------------------------------------------- previews --

private val previewEntry = ScratchlistEntry(
    entryId = "e1",
    text = "Try the alternative pagination cursor approach — ask the agent to benchmark both before committing.",
    createdAt = 1_755_000_000_000,
    updatedAt = 1_755_003_600_000,
    attachments = listOf(
        ScratchlistAttachment(
            id = "a1",
            filename = "sketch.png",
            mimeType = "image/png",
            size = 120_000,
            path = "hapi-hub:scratchlist/a1",
        ),
    ),
)

@Preview(showBackground = true)
@Composable
private fun ScratchlistEntryCardPreview() {
    HapiTheme {
        Surface {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                ScratchlistEntryCard(
                    entry = previewEntry,
                    media = ScratchlistMedia(imageLoader = null) { null },
                    onOpen = {},
                    onSendToComposer = {},
                    onOpenAttachment = {},
                )
                ScratchlistEntryCard(
                    entry = previewEntry.copy(entryId = "e2", text = "", attachments = emptyList()),
                    media = ScratchlistMedia(imageLoader = null) { null },
                    onOpen = {},
                    onSendToComposer = null,
                    onOpenAttachment = {},
                )
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun EmptyScratchlistPreview() {
    HapiTheme {
        Surface { EmptyScratchlist() }
    }
}

// ------------------------------------------------------------- notices --

/** Localize a [ScratchlistNotice] (B-M5a). */
internal fun scratchlistNoticeText(context: Context, notice: ScratchlistNotice): String = when (notice) {
    ScratchlistNotice.AtCapDeleteFirst -> context.getString(R.string.scratchlist_notice_full_delete_first)
    ScratchlistNotice.AtCap -> context.getString(R.string.scratchlist_notice_full)
    ScratchlistNotice.NeedsContent -> context.getString(R.string.scratchlist_notice_needs_content)
    ScratchlistNotice.SaveFailed -> context.getString(R.string.scratchlist_notice_save_failed)
    ScratchlistNotice.DeleteFailed -> context.getString(R.string.scratchlist_notice_delete_failed)
    ScratchlistNotice.AttachFailed -> context.getString(R.string.scratchlist_notice_attach_failed)
    ScratchlistNotice.RemoveAttachmentFailed ->
        context.getString(R.string.scratchlist_notice_remove_attachment_failed)
    ScratchlistNotice.UploadTooLarge -> context.getString(R.string.scratchlist_notice_too_large)
    ScratchlistNotice.UploadFailed -> context.getString(R.string.scratchlist_notice_upload_failed)
    is ScratchlistNotice.ImportRejected -> when (val reason = notice.reason) {
        ScratchlistImportRejection.Unreadable -> context.getString(R.string.scratchlist_reject_unreadable)
        ScratchlistImportRejection.ImageTooLarge -> context.getString(R.string.scratchlist_reject_image_too_large)
        is ScratchlistImportRejection.TooManyAttachments ->
            context.getString(R.string.scratchlist_reject_max_attachments, reason.max)
        ScratchlistImportRejection.FileTypeNotAllowed -> context.getString(R.string.scratchlist_reject_type)
        is ScratchlistImportRejection.FileTooLarge ->
            context.getString(R.string.scratchlist_reject_file_too_large, reason.maxMb)
        ScratchlistImportRejection.BudgetExhausted -> context.getString(R.string.scratchlist_reject_budget)
    }
}

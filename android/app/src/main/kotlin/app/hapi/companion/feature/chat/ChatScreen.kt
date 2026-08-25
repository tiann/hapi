package app.hapi.companion.feature.chat

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import android.content.Context
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.hapi.companion.R
import app.hapi.companion.feature.chat.composer.DictationErrorKind
import app.hapi.companion.feature.chat.attachments.AttachmentPickerSheet
import app.hapi.companion.feature.chat.attachments.AttachmentPreparer
import app.hapi.companion.feature.chat.attachments.CameraCapture
import app.hapi.companion.feature.chat.attachments.PrepareResult
import app.hapi.companion.feature.chat.composer.ChatComposer
import app.hapi.companion.feature.chat.composer.DictationController
import app.hapi.companion.feature.chat.composer.DictationEvent
import app.hapi.companion.feature.chat.composer.DictationState
import app.hapi.companion.feature.chat.composer.QueuedMessagesBar
import app.hapi.companion.feature.files.FolderGlyph
import app.hapi.companion.feature.sessions.DeleteSessionDialog
import app.hapi.companion.feature.sessions.RenameSessionDialog
import app.hapi.companion.ui.components.AgentFlavorIcon
import app.hapi.companion.ui.markdown.LocalMarkdownLinkHandler
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.VisibleChatBlock
import java.io.File
import kotlinx.coroutines.launch

/** How close to the oldest rendered block the viewport may get before paging. */
private const val LOAD_OLDER_PREFETCH_ITEMS = 4

/** Pending camera capture across rotation/process death: uri + scratch path. */
private val CameraCaptureSaver = listSaver<CameraCapture?, String>(
    save = { capture ->
        if (capture == null) emptyList() else listOf(capture.uri.toString(), capture.file.absolutePath)
    },
    restore = { saved ->
        if (saved.size < 2) null else CameraCapture(Uri.parse(saved[0]), File(saved[1]))
    },
)

/**
 * The chat screen: `LazyColumn(reverseLayout = true)` over the reduced
 * [VisibleChatBlock]s — newest at the bottom, stable ids as keys so scroll
 * position survives pipeline re-runs, auto-stick to the tail only while
 * already there (reverse-layout index-0 anchoring), a "new messages" pill
 * otherwise, and a top-edge sentinel that pages older history in.
 *
 * B-M3ab adds the interaction chrome: composer + queued bar (bottom),
 * permission actions (via [LocalChatInteractions]), the session config sheet
 * (top-bar gear), and one-shot [ChatEvent] handling (supersede renavigation +
 * snackbar notices).
 *
 * B-M3ce adds voice dictation (mic button, RECORD_AUDIO request, transcript
 * append), the slash-command dropdown, and session ops: a top-bar overflow
 * menu (Rename / Reopen / Delete) plus an inactive-session affordance bar
 * above the composer (send already auto-resumes; Reopen is the explicit path).
 *
 * B-M3f adds composer attachments: the "+" sheet (photo library / camera /
 * files), pick preparation ([AttachmentPreparer]: ContentResolver read +
 * image downscale + 50 MB reject) feeding the ViewModel's upload tray, and
 * the camera scratch capture (FileProvider Uri, `rememberSaveable` across
 * rotation while the camera app is up).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    viewModel: ChatViewModel,
    media: ChatMedia,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onNavigateToSession: (String) -> Unit = {},
    /** null ⇒ mic button hidden (tests / previews without a controller). */
    dictation: DictationController? = null,
    /** Top-bar folder icon → session files browser (B-M4c). */
    onOpenFiles: () -> Unit = {},
    /** Markdown file citations → file viewer (full mode; optional line hint). */
    onOpenFile: (path: String, line: Int?) -> Unit = { _, _ -> },
    /** null ⇒ no scratchlist top-bar entry (tests / previews). */
    onOpenScratchlist: (() -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    val composerState by viewModel.composer.collectAsState()
    val queuedRows by viewModel.queuedRows.collectAsState()
    val configState by viewModel.config.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var configSheetOpen by remember { mutableStateOf(false) }
    var renameDialogOpen by remember { mutableStateOf(false) }
    var deleteDialogOpen by remember { mutableStateOf(false) }

    DisposableEffect(viewModel) {
        viewModel.start()
        onDispose { viewModel.stop() }
    }

    val context = LocalContext.current
    LaunchedEffect(viewModel, context) {
        viewModel.events.collect { event ->
            when (event) {
                is ChatEvent.SessionSuperseded -> onNavigateToSession(event.sessionId)
                ChatEvent.SessionDeleted -> onBack()
                is ChatEvent.Notice -> snackbarHostState.showSnackbar(chatNoticeText(context, event.notice))
            }
        }
    }

    // ------------------------------------------------------------ dictation --
    val dictationState = dictation?.state?.collectAsState()?.value ?: DictationState.Idle
    LaunchedEffect(dictation, context) {
        dictation?.events?.collect { event ->
            when (event) {
                is DictationEvent.Transcribed -> viewModel.appendDictatedText(event.text)
                DictationEvent.NoProvider -> snackbarHostState.showSnackbar(
                    context.getString(R.string.chat_notice_no_transcription),
                )
                is DictationEvent.Error -> snackbarHostState.showSnackbar(
                    event.detail ?: context.getString(
                        when (event.kind) {
                            DictationErrorKind.StartFailed -> R.string.chat_dictation_start_failed
                            DictationErrorKind.HubUnreachable -> R.string.chat_dictation_hub_unreachable
                            DictationErrorKind.RecordingFailed -> R.string.chat_dictation_recording_failed
                            DictationErrorKind.NoAudio -> R.string.chat_dictation_no_audio
                            DictationErrorKind.TranscriptionFailed -> R.string.chat_dictation_failed
                        },
                    ),
                )
            }
        }
    }
    val scope = rememberCoroutineScope()
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            dictation?.toggle()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_mic_permission))
            }
        }
    }
    val onDictationToggle: () -> Unit = toggle@{
        val controller = dictation ?: return@toggle
        // Stopping never needs the permission; starting checks + requests it.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        when {
            dictationState !is DictationState.Idle -> controller.toggle()
            granted -> controller.toggle()
            else -> micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
    val slashSuggestions by viewModel.slashSuggestions.collectAsState()

    // --------------------------------------------------------- attachments --
    val attachmentItems by viewModel.attachments.items.collectAsState()
    var attachmentSheetOpen by remember { mutableStateOf(false) }
    val preparer = remember { AttachmentPreparer(context) }

    /** Read + policy-apply one pick, then hand it to the upload tray. */
    suspend fun ingestUri(uri: Uri) {
        when (val result = preparer.prepare(uri)) {
            is PrepareResult.Ready -> viewModel.attachments.add(result.attachment)
            is PrepareResult.TooLarge -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_too_large, result.filename),
            )
            is PrepareResult.Unreadable -> snackbarHostState.showSnackbar(
                context.getString(R.string.chat_notice_attachment_unreadable, result.filename),
            )
        }
    }

    fun ingestUris(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch { uris.forEach { ingestUri(it) } }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris -> ingestUris(uris) }
    val documentPickerLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> ingestUris(uris) }

    // The camera app may rotate/kill us while open — keep the scratch target.
    var pendingCapture by rememberSaveable(stateSaver = CameraCaptureSaver) {
        mutableStateOf<CameraCapture?>(null)
    }
    val takePictureLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { success ->
        val capture = pendingCapture
        pendingCapture = null
        if (capture == null) return@rememberLauncherForActivityResult
        if (!success) {
            capture.discard()
            return@rememberLauncherForActivityResult
        }
        scope.launch {
            ingestUri(capture.uri)
            capture.discard()
        }
    }

    fun launchCamera() {
        val capture = preparer.newCameraCapture()
        pendingCapture = capture
        takePictureLauncher.launch(capture.uri)
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchCamera()
        } else {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.chat_notice_camera_permission))
            }
        }
    }
    val onTakePhoto: () -> Unit = {
        // The manifest declares CAMERA (QR pairing), which makes the runtime
        // grant mandatory for ACTION_IMAGE_CAPTURE too.
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val interactions = remember(state.flavor, state.permissionOverrides, viewModel) {
        ChatInteractions(
            flavor = state.flavor,
            permissionOverrides = state.permissionOverrides,
            resolvePermission = viewModel::resolvePermission,
            retryFailedMessage = viewModel::retryFailedMessage,
        )
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.chat_back))
                    }
                },
                title = { ChatTitle(state.header) },
                actions = {
                    // Two icons max (device feedback: four icons squeezed the
                    // title out) — gear for the frequent config switches,
                    // everything else in the overflow menu.
                    IconButton(onClick = { configSheetOpen = true }) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.chat_open_settings))
                    }
                    val scratchlistCount by viewModel.scratchlistCount.collectAsState()
                    SessionOverflowMenu(
                        active = state.header.active,
                        onOpenFiles = onOpenFiles,
                        scratchlistCount = scratchlistCount,
                        onOpenScratchlist = if (viewModel.scratchlistEnabled) onOpenScratchlist else null,
                        onRename = { renameDialogOpen = true },
                        onReopen = viewModel::reopenSession,
                        onDelete = { deleteDialogOpen = true },
                        // Draft-level action, relocated from the composer's
                        // own overflow (one less button in the input bar).
                        onParkDraft = if (viewModel.scratchlistEnabled && composerState.text.isNotBlank()) {
                            viewModel::parkComposerDraft
                        } else {
                            null
                        },
                    )
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        bottomBar = {
            // Edge-to-edge (enforced by targetSdk 35+): the bar owns its own
            // system insets — nav-bar padding when the keyboard is closed,
            // IME padding when open (inset consumption prevents doubling).
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
                if (!state.header.active && !state.isInitialLoading && !state.loadFailed) {
                    InactiveSessionBar(onReopen = viewModel::reopenSession)
                }
                QueuedMessagesBar(
                    rows = queuedRows,
                    onSteer = viewModel::steerQueuedMessage,
                    onRetry = viewModel::retryIndeterminateMessage,
                    onEdit = viewModel::editQueuedMessage,
                    onCancel = viewModel::cancelQueuedMessage,
                )
                ChatComposer(
                    state = composerState,
                    onTextChange = viewModel::setComposerText,
                    onSend = { viewModel.sendMessage() },
                    onSendSteer = { viewModel.sendMessage(steer = true) },
                    onAbort = viewModel::abortSession,
                    attachments = attachmentItems,
                    onAddAttachment = { attachmentSheetOpen = true },
                    onAttachmentRetry = viewModel.attachments::retry,
                    onAttachmentRemove = viewModel.attachments::remove,
                    slashSuggestions = slashSuggestions,
                    onSlashCommandSelected = viewModel::selectSlashCommand,
                    dictation = if (dictation != null) dictationState else null,
                    onDictationToggle = onDictationToggle,
                    onDictationCancel = { dictation?.cancel() },
                )
            }
        },
    ) { padding ->
        CompositionLocalProvider(
            LocalChatMedia provides media,
            LocalMarkdownLinkHandler provides rememberChatLinkHandler(onOpenFile = onOpenFile),
            LocalChatInteractions provides interactions,
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            ) {
                state.warning?.let { warning ->
                    DegradedBanner(warning = warning, onRetry = viewModel::retry)
                }
                Box(modifier = Modifier.weight(1f)) {
                    when {
                        state.isInitialLoading -> InitialLoading()
                        state.loadFailed -> LoadFailed(onRetry = viewModel::retry)
                        state.blocks.isEmpty() -> EmptyChat()
                        else -> BlockList(state = state, onLoadOlder = viewModel::loadOlder)
                    }
                }
            }
        }
    }

    if (attachmentSheetOpen) {
        AttachmentPickerSheet(
            onDismiss = { attachmentSheetOpen = false },
            onPickPhotos = {
                photoPickerLauncher.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo),
                )
            },
            onTakePhoto = onTakePhoto,
            onPickFiles = { documentPickerLauncher.launch(arrayOf("*/*")) },
        )
    }
    if (configSheetOpen) {
        SessionConfigSheet(
            config = configState,
            onDismiss = { configSheetOpen = false },
            onSetPermissionMode = viewModel::setPermissionMode,
            onSetModel = viewModel::setModel,
            onSetEffort = viewModel::setEffort,
            onLoadModelOptions = viewModel::loadModelOptions,
        )
    }
    if (renameDialogOpen) {
        RenameSessionDialog(
            initialName = state.header.name ?: state.header.title,
            onConfirm = { name ->
                renameDialogOpen = false
                viewModel.renameSession(name)
            },
            onDismiss = { renameDialogOpen = false },
        )
    }
    if (deleteDialogOpen) {
        DeleteSessionDialog(
            sessionTitle = state.header.title,
            onConfirm = {
                deleteDialogOpen = false
                viewModel.deleteSession()
            },
            onDismiss = { deleteDialogOpen = false },
        )
    }
}

/**
 * Top-bar ⋮ menu: navigation entries first (Files always, Scratchlist with
 * entry count when enabled), then Rename always; Reopen only for inactive
 * sessions; Delete last.
 */
@Composable
private fun SessionOverflowMenu(
    active: Boolean,
    onRename: () -> Unit,
    onReopen: () -> Unit,
    onDelete: () -> Unit,
    onOpenFiles: () -> Unit = {},
    /** Entry-count suffix on the scratchlist row. */
    scratchlistCount: Int = 0,
    /** null ⇒ scratchlist row hidden (feature off / tests). */
    onOpenScratchlist: (() -> Unit)? = null,
    /** null ⇒ hidden (scratchlist off or empty composer). */
    onParkDraft: (() -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.chat_session_actions))
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.chat_open_files)) },
            leadingIcon = { Icon(FolderGlyph, contentDescription = null) },
            onClick = {
                open = false
                onOpenFiles()
            },
        )
        if (onOpenScratchlist != null) {
            DropdownMenuItem(
                text = {
                    Text(
                        if (scratchlistCount > 0) {
                            stringResource(R.string.chat_open_scratchlist_count, scratchlistCount)
                        } else {
                            stringResource(R.string.chat_open_scratchlist)
                        },
                    )
                },
                onClick = {
                    open = false
                    onOpenScratchlist()
                },
            )
        }
        HorizontalDivider()
        DropdownMenuItem(
            text = { Text(stringResource(R.string.sessions_action_rename)) },
            onClick = {
                open = false
                onRename()
            },
        )
        if (onParkDraft != null) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_park_draft)) },
                onClick = {
                    open = false
                    onParkDraft()
                },
            )
        }
        if (!active) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.sessions_action_reopen)) },
                onClick = {
                    open = false
                    onReopen()
                },
            )
        }
        DropdownMenuItem(
            text = { Text(stringResource(R.string.sessions_action_delete), color = MaterialTheme.colorScheme.error) },
            onClick = {
                open = false
                onDelete()
            },
        )
    }
}

/**
 * Inactive-session affordance above the composer: sending auto-resumes
 * (B-M3ab), Reopen is the explicit restart without a message.
 */
@Composable
private fun InactiveSessionBar(onReopen: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(R.string.chat_inactive_bar),
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 4.dp, bottom = 4.dp),
            )
            TextButton(onClick = onReopen) { Text(stringResource(R.string.sessions_action_reopen)) }
        }
    }
}

@Composable
private fun ChatTitle(header: ChatHeaderUi) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(active = header.active, thinking = header.thinking)
        Spacer(modifier = Modifier.width(8.dp))
        Column {
            Text(
                text = header.title,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            header.subtitle?.let { subtitle ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    header.flavor?.let { flavor ->
                        // Hint-colored like the meta text (web: currentColor
                        // under --app-hint); color variants ignore the tint.
                        CompositionLocalProvider(
                            LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant,
                        ) {
                            AgentFlavorIcon(flavor, modifier = Modifier.size(14.dp))
                        }
                        Spacer(modifier = Modifier.width(4.dp))
                    }
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusDot(active: Boolean, thinking: Boolean) {
    val color = when {
        thinking -> Color(0xFF34C759).copy(alpha = 0.6f)
        active -> Color(0xFF34C759)
        else -> MaterialTheme.colorScheme.outlineVariant
    }
    Box(
        modifier = Modifier
            .size(9.dp)
            .background(color, CircleShape),
    )
}

@Composable
private fun DegradedBanner(warning: String, onRetry: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = warning,
                style = MaterialTheme.typography.labelMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 16.dp, top = 6.dp, bottom = 6.dp),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
        }
    }
}

// ------------------------------------------------------------------- list --

@Composable
private fun BlockList(state: ChatUiState, onLoadOlder: () -> Unit) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // Newest-first for reverseLayout: index 0 renders at the bottom.
    val reversed = remember(state.blocks) { state.blocks.asReversed() }

    LoadOlderEffect(listState, state, onLoadOlder)

    Box(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(
                items = reversed,
                key = { it.stableId },
                contentType = { it.contentKind },
            ) { block ->
                ChatBlockCard(block = block, basePath = state.basePath)
            }
            if (state.hasMore || state.isLoadingOlder) {
                item(key = "older-history", contentType = "older-history") {
                    OlderHistoryRow(isLoading = state.isLoadingOlder)
                }
            }
        }

        NewMessagesPill(
            listState = listState,
            reversed = reversed,
            sessionId = state.sessionId,
            onClick = { scope.launch { listState.animateScrollToItem(0) } },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 12.dp),
        )
    }
}

/** Sentinel: when the viewport nears the oldest rendered block, page older history. */
@Composable
private fun LoadOlderEffect(listState: LazyListState, state: ChatUiState, onLoadOlder: () -> Unit) {
    val nearOldest by remember(listState) {
        derivedStateOf {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf false
            lastVisible >= info.totalItemsCount - 1 - LOAD_OLDER_PREFETCH_ITEMS
        }
    }
    LaunchedEffect(nearOldest, state.hasMore, state.isLoadingOlder, state.isSyncingTail) {
        if (nearOldest && state.hasMore && !state.isLoadingOlder && !state.isSyncingTail) {
            onLoadOlder()
        }
    }
}

@Composable
private fun OlderHistoryRow(isLoading: Boolean) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (isLoading) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = stringResource(R.string.chat_loading_older),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
            )
        } else {
            Text(
                text = "· · ·",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
            )
        }
    }
}

/**
 * "N new messages ↓" pill: appears when new blocks land while the reader is
 * scrolled up. At the bottom (reverse-layout index 0, offset 0) the list
 * auto-sticks and the pill stays hidden.
 */
@Composable
private fun NewMessagesPill(
    listState: LazyListState,
    reversed: List<VisibleChatBlock>,
    sessionId: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val atBottom by remember(listState) {
        derivedStateOf {
            listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset == 0
        }
    }
    var newestSeenId by remember(sessionId) { mutableStateOf<String?>(null) }
    val newestId = reversed.firstOrNull()?.stableId

    LaunchedEffect(atBottom, newestId) {
        if (atBottom) newestSeenId = newestId
    }

    val unseenCount = if (atBottom) {
        0
    } else {
        val seenId = newestSeenId
        if (seenId == null) 0
        else reversed.indexOfFirst { it.stableId == seenId }.coerceAtLeast(0)
    }
    if (unseenCount == 0) return

    Surface(
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = CircleShape,
        shadowElevation = 4.dp,
        onClick = onClick,
        modifier = modifier,
    ) {
        Text(
            text = if (unseenCount == 1) {
                stringResource(R.string.chat_new_messages_one)
            } else {
                stringResource(R.string.chat_new_messages_many, unseenCount)
            },
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
        )
    }
}

// ----------------------------------------------------------------- states --

@Composable
private fun InitialLoading() {
    Column(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.size(12.dp))
        Text(
            text = stringResource(R.string.chat_loading_messages),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LoadFailed(onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_load_failed_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_load_failed_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.size(12.dp))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
    }
}

@Composable
private fun EmptyChat() {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = stringResource(R.string.chat_empty_title), style = MaterialTheme.typography.titleMedium)
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.chat_empty_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ------------------------------------------------------------- notices --

/**
 * Localize a [ChatNotice] (B-M5a). Server/exception detail text, when
 * present, is shown verbatim — matching the pre-i18n `message ?: fallback`
 * behavior — so hub-side wording is never mistranslated.
 */
internal fun chatNoticeText(context: Context, notice: ChatNotice): String = when (notice) {
    ChatNotice.DraftParked -> context.getString(R.string.chat_notice_draft_parked)
    ChatNotice.ScratchlistFull -> context.getString(R.string.chat_notice_scratchlist_full)
    ChatNotice.ScratchlistParkFailed -> context.getString(R.string.chat_notice_park_failed)
    ChatNotice.AttachmentsUploading -> context.getString(R.string.chat_notice_attachments_uploading)
    ChatNotice.ResumeFailed -> context.getString(R.string.chat_notice_resume_failed)
    ChatNotice.QueuedEditKeptDraft -> context.getString(R.string.chat_notice_edit_kept_draft)
    ChatNotice.QueuedAlreadyDelivered -> context.getString(R.string.chat_notice_already_delivered)
    ChatNotice.PermissionAlreadyHandled -> context.getString(R.string.chat_notice_request_already_handled)
    ChatNotice.DeleteConflictActive -> context.getString(R.string.sessions_error_delete_active)
    is ChatNotice.AbortFailed -> notice.detail ?: context.getString(R.string.chat_notice_abort_failed)
    is ChatNotice.RenameFailed -> notice.detail ?: context.getString(R.string.chat_notice_rename_failed)
    is ChatNotice.DeleteFailed -> notice.detail ?: context.getString(R.string.chat_notice_delete_failed)
    is ChatNotice.ReopenFailed -> notice.detail ?: context.getString(R.string.sessions_reopen_failed_fallback)
    is ChatNotice.CancelQueuedFailed -> notice.detail ?: context.getString(R.string.chat_notice_cancel_failed)
    is ChatNotice.SteerFailed -> notice.detail ?: context.getString(R.string.chat_notice_steer_failed)
    is ChatNotice.PermissionRequestFailed -> notice.detail ?: context.getString(R.string.chat_notice_request_failed)
    is ChatNotice.ModelsLoadFailed -> notice.detail ?: context.getString(R.string.chat_notice_models_failed)
    is ChatNotice.ConfigUpdateFailed -> notice.detail ?: context.getString(R.string.chat_notice_config_failed)
}

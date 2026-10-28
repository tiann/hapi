package app.hapi.companion.feature.sessions

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.text.format.DateUtils
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.hapi.companion.R
import app.hapi.companion.ui.components.AgentFlavorIcon
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.PendingRequest
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import app.hapi.protocol.wire.TodoProgress
import kotlinx.coroutines.delay

/**
 * The session list (B-M2b) — standalone screen: navigation and app graph stay
 * outside; taps surface through [onOpenSession].
 *
 * Inventory (mirrors the web sidebar semantics):
 * - amber "Offline · updated …" notice with Retry over snapshot data (only a
 *   failed refresh; transient SSE states are a quiet top-bar subtitle shown
 *   after 2s), pull-to-refresh, empty state and no-search-results state;
 *   search and filters live in the home toolbar;
 * - duplicate agent-session views are collapsed and fresh "new session"
 *   stubs hidden (ViewModel pipeline, web sidebar parity);
 * - pinned section first (the sort already puts globalPinned/pinned rows on
 *   top; compact "Pinned" / "Recent" headers mark the boundary);
 * - per row: a two-line-tall flavor icon whose presence badge marks
 *   connected sessions (pulsing while a turn is in flight), title with a
 *   right-aligned relative `updatedAt` (unread: semibold title + accent
 *   time, no dot), summary line, `project · worktree · machine` meta line
 *   (machine only when it disambiguates) with todo chip and pending badge
 *   trailing. Disconnected rows are not dimmed and have no spinner;
 * - swipe: start→end pin/unpin (project), end→start archive (live) or
 *   delete with confirmation (inactive); the row snaps back;
 * - long-press → actions sheet: mark read (unread rows), pin
 *   (none/project/global), rename (dialog),
 *   reopen (inactive rows; navigates into the possibly-superseding id),
 *   archive, delete (confirm; 409 while active) — optimistic store updates;
 *   failures land in a snackbar (B-M2b + B-M3ce).
 *
 * The host (`HomeScreen` via Navigation) constructs the ViewModel from the
 * active `HubGraph` and routes [onOpenSession] to the chat screen. This
 * screen starts/stops the ViewModel — and with it the global SSE
 * subscription — with its composition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    viewModel: SessionListViewModel,
    onOpenSession: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    /** Shows the "+" FAB (new-session form, B-M3d) when non-null. */
    onNewSession: (() -> Unit)? = null,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var sheetRow by remember { mutableStateOf<SessionRowUi?>(null) }
    var renameRow by remember { mutableStateOf<SessionRowUi?>(null) }
    var deleteRow by remember { mutableStateOf<SessionRowUi?>(null) }

    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(viewModel, context, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.refreshTimeZone()
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == Intent.ACTION_TIMEZONE_CHANGED) viewModel.refreshTimeZone()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        ContextCompat.registerReceiver(
            context, receiver, IntentFilter(Intent.ACTION_TIMEZONE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        viewModel.start()
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            context.unregisterReceiver(receiver)
            viewModel.stop()
        }
    }

    LaunchedEffect(viewModel, context) {
        viewModel.errors.collect { error ->
            val label = context.getString(
                when (error) {
                    is SessionListError.PinFailed -> R.string.sessions_error_pin
                    is SessionListError.ArchiveFailed -> R.string.sessions_error_archive
                    is SessionListError.RenameFailed -> R.string.sessions_error_rename
                    is SessionListError.DeleteFailed -> R.string.sessions_error_delete
                    is SessionListError.ReopenFailed -> R.string.sessions_error_reopen
                    is SessionListError.MachinesRefreshFailed -> R.string.sessions_error_machines
                    is SessionListError.MarkReadFailed -> R.string.sessions_error_mark_read
                },
            )
            // The 409-on-delete conflict gets explicit wording; other messages
            // are hub/server text appended verbatim.
            val message = when {
                error is SessionListError.DeleteFailed && error.stillActive ->
                    context.getString(R.string.sessions_error_delete_active)
                else -> error.message
            }
            snackbarHostState.showSnackbar(message?.let { "$label: $it" } ?: label)
        }
    }

    // Reopen may hand back a superseding id — open whatever the hub returned.
    LaunchedEffect(viewModel) {
        viewModel.reopened.collect { sessionId ->
            viewModel.onSessionOpened(sessionId)
            onOpenSession(sessionId)
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        Column(modifier = Modifier.fillMaxSize()) {
            if (state.isOffline) {
                OfflineNotice(lastRefreshedAt = state.lastRefreshedAt, onRetry = viewModel::refresh)
            }
            PullToRefreshBox(
                isRefreshing = state.isRefreshing,
                onRefresh = viewModel::refresh,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                if (state.rows.isEmpty()) {
                    if (state.isSearching) {
                        SearchEmptyState(query = state.searchQuery)
                    } else {
                        EmptyState(hasLoaded = state.hasLoaded, isOffline = state.isOffline, hasDateFilter = state.dateRange != null)
                    }
                } else {
                    SessionRows(
                        rows = state.rows,
                        onOpen = { sessionId ->
                            viewModel.onSessionOpened(sessionId)
                            onOpenSession(sessionId)
                        },
                        onLongPress = { sheetRow = it },
                        onSwipePin = { row ->
                            val pinned = row.summary.pinned == true || row.summary.globalPinned == true
                            viewModel.setPinMode(row.id, if (pinned) PinMode.None else PinMode.Project)
                        },
                        onSwipeEnd = { row ->
                            if (row.summary.active) viewModel.archiveSession(row.id) else deleteRow = row
                        },
                    )
                }
            }
        }
        onNewSession?.let { openNewSession ->
            FloatingActionButton(
                onClick = openNewSession,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            ) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = stringResource(R.string.new_session_fab),
                )
            }
        }
        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }

    sheetRow?.let { row ->
        SessionActionsSheet(
            row = row,
            onDismiss = { sheetRow = null },
            onSetPinMode = { mode ->
                viewModel.setPinMode(row.id, mode)
                sheetRow = null
            },
            onArchive = {
                viewModel.archiveSession(row.id)
                sheetRow = null
            },
            onRename = {
                renameRow = row
                sheetRow = null
            },
            onReopen = {
                viewModel.reopenSession(row.id)
                sheetRow = null
            },
            onDelete = {
                deleteRow = row
                sheetRow = null
            },
            onMarkRead = {
                viewModel.markRead(row.id)
                sheetRow = null
            },
        )
    }
    renameRow?.let { row ->
        RenameSessionDialog(
            initialName = row.summary.metadata?.name ?: row.title,
            onConfirm = { name ->
                viewModel.renameSession(row.id, name)
                renameRow = null
            },
            onDismiss = { renameRow = null },
        )
    }
    deleteRow?.let { row ->
        DeleteSessionDialog(
            sessionTitle = row.title,
            onConfirm = {
                viewModel.deleteSession(row.id)
                deleteRow = null
            },
            onDismiss = { deleteRow = null },
        )
    }
}

// ------------------------------------------------------------------ list --

@Composable
private fun SessionRows(
    rows: List<SessionRowUi>,
    onOpen: (String) -> Unit,
    onLongPress: (SessionRowUi) -> Unit,
    onSwipePin: (SessionRowUi) -> Unit = {},
    onSwipeEnd: (SessionRowUi) -> Unit = {},
) {
    // The sort contract puts globalPinned/pinned rows first; the boundary
    // index is where the pinned section ends.
    val pinnedCount = rows.takeWhile {
        it.summary.globalPinned == true || it.summary.pinned == true
    }.size

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        if (pinnedCount > 0) {
            item(key = "header-pinned") { SectionHeader(stringResource(R.string.sessions_section_pinned)) }
        }
        items(rows.take(pinnedCount), key = { it.id }) { row ->
            SwipeableSessionRow(row, onOpen, onLongPress, onSwipePin, onSwipeEnd)
        }
        if (pinnedCount in 1 until rows.size) {
            // "Recent", not "Sessions": the top bar title already says so.
            item(key = "header-recent") { SectionHeader(stringResource(R.string.sessions_section_recent)) }
        }
        items(rows.drop(pinnedCount), key = { it.id }) { row ->
            SwipeableSessionRow(row, onOpen, onLongPress, onSwipePin, onSwipeEnd)
        }
    }
}

/** Compact header (iOS/Mail-style): small semibold secondary text. */
@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
    )
}

/**
 * Swipe start→end toggles the project pin; end→start archives a live
 * session or asks to delete an inactive one (the hub archives live sessions
 * only). The row never dismisses: the action runs and the row snaps back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableSessionRow(
    row: SessionRowUi,
    onOpen: (String) -> Unit,
    onLongPress: (SessionRowUi) -> Unit,
    onSwipePin: (SessionRowUi) -> Unit,
    onSwipeEnd: (SessionRowUi) -> Unit,
) {
    val currentRow by rememberUpdatedState(row)
    val state = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.StartToEnd -> onSwipePin(currentRow)
                SwipeToDismissBoxValue.EndToStart -> onSwipeEnd(currentRow)
                SwipeToDismissBoxValue.Settled -> Unit
            }
            false
        },
    )
    SwipeToDismissBox(
        state = state,
        backgroundContent = { SwipeBackground(row, state.dismissDirection) },
    ) {
        Surface(color = MaterialTheme.colorScheme.surface) {
            SessionRow(row, onOpen = onOpen, onLongPress = onLongPress)
        }
    }
}

@Composable
private fun SwipeBackground(row: SessionRowUi, direction: SwipeToDismissBoxValue) {
    val summary = row.summary
    val pinned = summary.pinned == true || summary.globalPinned == true
    val (color, label, icon) = when (direction) {
        SwipeToDismissBoxValue.StartToEnd -> Triple(
            Color(0xFFFF9500),
            stringResource(if (pinned) R.string.sessions_action_unpin else R.string.sessions_action_pin_project),
            painterResource(R.drawable.ic_push_pin),
        )
        SwipeToDismissBoxValue.EndToStart -> if (summary.active) {
            Triple(Color(0xFF5856D6), stringResource(R.string.sessions_action_archive), painterResource(R.drawable.ic_archive))
        } else {
            Triple(MaterialTheme.colorScheme.error, stringResource(R.string.sessions_action_delete), rememberVectorPainter(Icons.Default.Delete))
        }
        SwipeToDismissBoxValue.Settled -> return
    }
    Row(
        modifier = Modifier
            .fillMaxSize()
            .background(color)
            .padding(horizontal = 20.dp),
        horizontalArrangement = if (direction == SwipeToDismissBoxValue.StartToEnd) Arrangement.Start else Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
        Spacer(modifier = Modifier.width(8.dp))
        Text(label, color = Color.White, style = MaterialTheme.typography.labelLarge)
    }
}

private val ICON_SIZE = 30.dp
private val ICON_SPACING = 12.dp
private val PRESENCE_GREEN = Color(0xFF34C759)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    row: SessionRowUi,
    onOpen: (String) -> Unit,
    onLongPress: (SessionRowUi) -> Unit,
) {
    val summary = row.summary
    val unreadLabel = stringResource(R.string.sessions_unread)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(
                onClick = { onOpen(row.id) },
                onLongClick = { onLongPress(row) },
            )
            .semantics(mergeDescendants = true) { if (row.unread) stateDescription = unreadLabel }
            .padding(start = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The agent owns a two-line-tall leading column; its presence badge
        // marks connected sessions (pulsing while running) instead of
        // dimming every disconnected row.
        AgentIconWithPresence(row)
        Spacer(modifier = Modifier.width(ICON_SPACING))
        // The divider starts under the text column, as in Mail/Messages.
        Column(modifier = Modifier.weight(1f)) {
            Column(modifier = Modifier.padding(end = 16.dp, top = 10.dp, bottom = 10.dp)) {
                TitleLine(row)
                // Summary directly under the title (its prose continuation);
                // the `project · machine` meta closes the row as a footer.
                row.subtitle?.let { subtitle ->
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                MetaLine(row)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
        }
    }
}

@Composable
private fun AgentIconWithPresence(row: SessionRowUi) {
    val summary = row.summary
    Box(modifier = Modifier.size(ICON_SIZE)) {
        AgentFlavorIcon(
            row.flavor,
            modifier = Modifier
                .size(ICON_SIZE * 0.8f)
                .align(Alignment.Center),
        )
        if (summary.active) {
            val running = summary.thinking
            val alpha = if (running) {
                val transition = rememberInfiniteTransition(label = "presence")
                transition.animateFloat(
                    initialValue = 1f,
                    targetValue = 0.35f,
                    animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
                    label = "presence-pulse",
                ).value
            } else {
                1f
            }
            val presence = stringResource(
                if (running) R.string.sessions_presence_running else R.string.sessions_presence_connected,
            )
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 2.dp, y = 2.dp)
                    .size(12.dp)
                    .background(MaterialTheme.colorScheme.surface, CircleShape)
                    .padding(2.dp)
                    .semantics { contentDescription = presence },
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer { this.alpha = alpha }
                        .background(PRESENCE_GREEN, CircleShape),
                )
            }
        }
    }
}

/**
 * Title + right-aligned relative age. Unread is a semibold title plus an
 * accent timestamp — no dot, so the presence badge stays the row's only dot
 * and every timestamp shares one column.
 */
@Composable
private fun TitleLine(row: SessionRowUi) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        // One weighted element only: the title takes ALL leftover width
        // (start-aligned, ellipsis on true overflow). Splitting the slack
        // with a weighted trailing spacer truncated even short names at
        // ~half the row (device-observed).
        Text(
            text = row.title,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = if (row.unread) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = localizedRelativeAge(row.summary.updatedAt),
            style = MaterialTheme.typography.bodySmall,
            fontWeight = if (row.unread) FontWeight.SemiBold else FontWeight.Normal,
            color = if (row.unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// `project · worktree · machine`, composed in the ViewModel (machine only
// when it disambiguates). Attention (pending requests) and todo progress sit
// trailing on this last line; routine activity lives on the icon badge.
@Composable
private fun MetaLine(row: SessionRowUi) {
    val summary = row.summary
    val meta = listOfNotNull(row.meta, row.machine?.let { machineFilterLabel(it) }).joinToString(" · ")
    val hasPending = summary.pendingRequestsCount > 0
    val todoProgress = summary.todoProgress
    if (meta.isEmpty() && !hasPending && todoProgress == null) return
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = meta,
            // bodySmall, not labelSmall: the meta carries the project scan
            // key — label tracking (0.5sp at 11sp) reads stringy on
            // path-like text (web parity: title 14 / meta 12).
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (hasPending || todoProgress != null) {
            Spacer(modifier = Modifier.width(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                todoProgress?.let { TodoChip(it) }
                if (hasPending) {
                    PendingBadge(
                        count = summary.pendingRequestsCount,
                        kinds = summary.pendingRequestKinds,
                        requests = summary.pendingRequests,
                    )
                }
            }
        }
    }
}

/**
 * Pending badge: authoritative `pendingRequestsCount` + kind wording; the
 * capped `pendingRequests` slice names the first tool.
 */
@Composable
private fun PendingBadge(count: Int, kinds: List<String>, requests: List<PendingRequest>) {
    val needsInput = kinds.contains("input") && !kinds.contains("permission")
    val label = when {
        needsInput -> stringResource(R.string.sessions_badge_needs_input)
        requests.isNotEmpty() -> stringResource(R.string.sessions_badge_approve, requests.first().tool)
        else -> stringResource(R.string.sessions_badge_pending)
    }
    val text = if (count > 1) "$count · $label" else label
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        shape = RoundedCornerShape(6.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@Composable
private fun TodoChip(progress: TodoProgress) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
        shape = RoundedCornerShape(6.dp),
    ) {
        Text(
            text = "☑ ${progress.completed}/${progress.total}",
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

// --------------------------------------------------------------- chrome --

/**
 * Only a failed list refresh (cached data on screen) is amber, with when the
 * list last updated and Retry. Transient connection states stay quiet in the
 * top bar subtitle instead (`HomeTopBar`).
 */
@Composable
private fun OfflineNotice(lastRefreshedAt: Long?, onRetry: () -> Unit) {
    // Minute ticks keep "updated … ago" honest while offline.
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(60_000)
            value = System.currentTimeMillis()
        }
    }
    val attention = if (isSystemInDarkTheme()) Color(0xFFD29922) else Color(0xFF9A6700)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .background(attention.copy(alpha = 0.12f), RoundedCornerShape(12.dp))
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_cloud_off), contentDescription = null, tint = attention, modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = lastRefreshedAt?.let {
                val age = DateUtils.getRelativeTimeSpanString(it, now, DateUtils.MINUTE_IN_MILLIS).toString()
                stringResource(R.string.sessions_offline_updated, age)
            } ?: stringResource(R.string.sessions_offline_banner),
            style = MaterialTheme.typography.bodySmall,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp),
        )
        TextButton(onClick = onRetry) {
            Text(stringResource(R.string.sessions_offline_retry), fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Search active but nothing matched — distinct from the plain empty list. */
@Composable
private fun SearchEmptyState(query: String) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.sessions_search_no_results, query),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(R.string.sessions_search_no_results_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun EmptyState(hasLoaded: Boolean, isOffline: Boolean, hasDateFilter: Boolean = false) {
    // verticalScroll keeps the pull-to-refresh gesture available even though
    // there is nothing to scroll.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(
                when {
                    !hasLoaded && !isOffline -> R.string.sessions_empty_loading_title
                    isOffline -> R.string.sessions_empty_offline_title
                    hasDateFilter -> R.string.sessions_time_filter_empty_title
                    else -> R.string.sessions_empty_title
                },
            ),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(modifier = Modifier.size(8.dp))
        Text(
            text = stringResource(
                when {
                    !hasLoaded && !isOffline -> R.string.sessions_empty_loading_hint
                    isOffline -> R.string.sessions_empty_offline_hint
                    hasDateFilter -> R.string.sessions_time_filter_empty_hint
                    else -> R.string.sessions_empty_hint
                },
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionActionsSheet(
    row: SessionRowUi,
    onDismiss: () -> Unit,
    onSetPinMode: (PinMode) -> Unit,
    onArchive: () -> Unit,
    onRename: () -> Unit,
    onReopen: () -> Unit,
    onDelete: () -> Unit,
    onMarkRead: () -> Unit = {},
) {
    val summary = row.summary
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text(
            text = row.title,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        HorizontalDivider()
        if (row.unread) {
            SheetAction(stringResource(R.string.sessions_action_mark_read), onClick = onMarkRead)
        }
        if (summary.pinned == true || summary.globalPinned == true) {
            SheetAction(stringResource(R.string.sessions_action_unpin)) { onSetPinMode(PinMode.None) }
        }
        if (summary.pinned != true) {
            SheetAction(stringResource(R.string.sessions_action_pin_project)) { onSetPinMode(PinMode.Project) }
        }
        if (summary.globalPinned != true) {
            SheetAction(stringResource(R.string.sessions_action_pin_global)) { onSetPinMode(PinMode.Global) }
        }
        SheetAction(stringResource(R.string.sessions_action_rename), onClick = onRename)
        if (!summary.active) {
            SheetAction(stringResource(R.string.sessions_action_reopen), onClick = onReopen)
        }
        SheetAction(stringResource(R.string.sessions_action_archive), destructive = true, onClick = onArchive)
        SheetAction(stringResource(R.string.sessions_action_delete), destructive = true, onClick = onDelete)
        Spacer(modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun SheetAction(text: String, destructive: Boolean = false, onClick: () -> Unit) {
    ListItem(
        headlineContent = {
            Text(
                text = text,
                color = if (destructive) MaterialTheme.colorScheme.error else Color.Unspecified,
            )
        },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

// -------------------------------------------------------------- preview --

private fun previewRow(
    id: String,
    title: String,
    active: Boolean = false,
    thinking: Boolean = false,
    unread: Boolean = false,
    pinned: Boolean = false,
    pending: Int = 0,
    todo: TodoProgress? = null,
): SessionRowUi = SessionRowUi(
    summary = SessionSummary(
        id = id,
        active = active,
        thinking = thinking,
        activeAt = 0,
        updatedAt = System.currentTimeMillis() - 300_000,
        pinned = pinned,
        metadata = SessionSummaryMetadata(
            path = "/data/github/hapi",
            flavor = "claude",
            summary = SummaryText("Porting the session list to Compose"),
        ),
        todoProgress = todo,
        pendingRequestsCount = pending,
        pendingRequestKinds = if (pending > 0) listOf("permission") else emptyList(),
        pendingRequests = if (pending > 0) {
            listOf(PendingRequest(id = "r1", kind = "permission", tool = "Bash", since = 0))
        } else {
            emptyList()
        },
    ),
    title = title,
    subtitle = "Porting the session list to Compose",
    meta = "github/hapi · devbox",
    flavor = "claude",
    unread = unread,
)

@Preview(showBackground = true)
@Composable
private fun SessionRowsPreview() {
    HapiTheme {
        Surface {
            SessionRows(
                rows = listOf(
                    previewRow("s1", "Pinned build fix", pinned = true),
                    previewRow("s2", "Session list UI", active = true, thinking = true, unread = true, todo = TodoProgress(3, 5)),
                    previewRow("s3", "Fixture sweep", active = true, pending = 2),
                    previewRow("s4", "Old research"),
                ),
                onOpen = {},
                onLongPress = {},
            )
        }
    }
}

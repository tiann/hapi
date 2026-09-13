package app.hapi.companion.feature.chat

import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.data.store.ChatHistoryPagingState
import app.hapi.protocol.chat.VisibleChatBlock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext

private const val HISTORY_KEY = "chat-history-control"

private data class TranscriptItem(val block: VisibleChatBlock) {
    val id: String get() = block.stableId
}

/** Positive-order keys preserve the TOP reading anchor, including tall rows
 * whose bottom is still streaming. No prepend invokes scrollToItem. */
@Composable
internal fun ChatTranscript(
    state: ChatUiState,
    paging: ChatHistoryPagingState,
    jumpToken: Long,
    jumpingLatest: Boolean,
    onViewport: (Boolean, Boolean) -> Unit,
    onLayout: (Long, Boolean) -> Unit,
    onRetryHistory: () -> Unit,
    onJumpToLatest: () -> Unit,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
    readingState: TranscriptReadingState = rememberTranscriptReadingState(state.sessionId),
) {
    val rowState = rememberSaveableStateHolder()
    val stateKeys = remember(state.sessionId) { mutableSetOf<String>() }
    val rows = remember(state.blocks) { state.blocks.map(::TranscriptItem) }
    val heights = remember(state.sessionId) { mutableMapOf<String, Int>() }
    val density = LocalDensity.current
    val estimatedHeight = with(density) { 100.dp.roundToPx() }
    val spacing = with(density) { 10.dp.roundToPx() }
    val headerHeight = with(density) { 44.dp.roundToPx() }
    val isDragged by listState.interactionSource.collectIsDraggedAsState()
    // Restore intent with LazyListState, otherwise the first tail effect
    // overwrites a saved history position on navigation/activity recreation.
    var followsTail by readingState::followsTail
    var consumedJumpToken by rememberSaveable(state.sessionId) { mutableLongStateOf(0) }
    var correctingTail by remember(state.sessionId) { mutableStateOf(false) }
    var renderedHistoryVersion by remember(state.sessionId) { mutableLongStateOf(-1) }
    val currentRows by rememberUpdatedState(rows)
    val rowIDs = remember(rows) { rows.mapTo(mutableSetOf()) { it.id } }
    val currentIDs by rememberUpdatedState(rowIDs)
    val currentState by rememberUpdatedState(state)
    val currentJumpToken by rememberUpdatedState(jumpToken)
    val reportViewport by rememberUpdatedState(onViewport)
    val reportLayout by rememberUpdatedState(onLayout)

    LaunchedEffect(state.sessionId, listState) {
        var lastVersion = -1L
        var readerWasScrolling = false
        var previousIDs = emptySet<String>()
        var previousVisibleHeight = 0
        var lastReadingDemand: Pair<Boolean, Boolean>? = null
        snapshotFlow {
            val info = listState.layoutInfo
            val current = currentRows
            val height = info.viewportEndOffset - info.viewportStartOffset
            // Wait until visible keys occupy their NEW indices. A same-size
            // bounded-window replacement is not identified by count alone.
            val matches = info.totalItemsCount == current.size + 1 &&
                info.visibleItemsInfo.all { item ->
                    if (item.index == 0) item.key == HISTORY_KEY
                    else current.getOrNull(item.index - 1)?.id == item.key
                }
            var distance = listState.firstVisibleItemScrollOffset
            for (index in 0 until listState.firstVisibleItemIndex) {
                distance += if (index == 0) headerHeight + spacing
                    else (heights[current.getOrNull(index - 1)?.id] ?: estimatedHeight) + spacing
                if (distance > height) break
            }
            val short = !listState.canScrollBackward && !listState.canScrollForward
            LayoutReport(
                version = currentState.historyVersion,
                matches = matches && renderedHistoryVersion == currentState.historyVersion &&
                    height > 0 && info.visibleItemsInfo.isNotEmpty(),
                short = short,
                nearTop = !listState.canScrollBackward || distance <= height,
                atBottom = !listState.canScrollForward,
                scrolling = listState.isScrollInProgress,
                ownScroll = correctingTail,
                following = followsTail,
                ids = currentIDs,
                visibleHeight = info.visibleItemsInfo.sumOf { it.size },
            )
        }.collect { report ->
            if (!report.matches) return@collect
            if (report.scrolling && !report.ownScroll) {
                readerWasScrolling = true
                followsTail = false
            } else if (!report.scrolling && readerWasScrolling) {
                followsTail = report.atBottom
                readerWasScrolling = false
            }
            val demand = followsTail to (report.short || (!followsTail && report.nearTop))
            if (demand != lastReadingDemand) {
                lastReadingDemand = demand
                reportViewport(demand.first, demand.second)
            }
            if (report.version != lastVersion) {
                val progress = report.ids.any { it !in previousIDs } ||
                    (report.ids == previousIDs && report.visibleHeight > previousVisibleHeight + 1)
                lastVersion = report.version
                reportLayout(report.version, progress)
            }
            previousIDs = report.ids
            previousVisibleHeight = report.visibleHeight
        }
    }

    LaunchedEffect(isDragged) {
        if (isDragged) {
            followsTail = false
            // Publish history mode at gesture start, before a live update can
            // use tail-mode trimming while the reader is moving away.
            // snapshotFlow observes followsTail and reports actual demand;
            // do not cancel a valid near-top load on every new finger-down.
        }
    }
    LaunchedEffect(state.sessionId, jumpToken) {
        if (jumpToken > 0 && jumpToken != consumedJumpToken) followsTail = true
        // Tokens are scoped to the ViewModel; it may restart at zero after
        // process recreation. Rebase without treating zero as a jump.
        consumedJumpToken = jumpToken
    }

    // layoutInfo changes on every scroll frame. Reading it in composition
    // invalidates the ENTIRE transcript, even while browsing old messages.
    // Observe tail geometry in an effect instead; drop geometry observation
    // altogether while not following. collectLatest cancels our correction
    // immediately when a reader takes over the scroll.
    LaunchedEffect(state.sessionId, listState) {
        snapshotFlow {
            if (!followsTail || isDragged) null else {
                val info = listState.layoutInfo
                val lastIndex = currentRows.size
                TailLayout(
                    lastIndex = lastIndex,
                    itemCount = info.totalItemsCount,
                    viewportHeight = info.viewportSize.height,
                    lastHeight = info.visibleItemsInfo.lastOrNull()?.takeIf { it.index == lastIndex }?.size,
                    canScrollForward = listState.canScrollForward,
                    messagesVersion = currentState.messagesVersion,
                    jumpToken = currentJumpToken,
                )
            }
        }.collectLatest { tail ->
            if (tail == null || tail.lastIndex == 0 || tail.viewportHeight == 0 ||
                tail.itemCount != tail.lastIndex + 1 || (!tail.canScrollForward && tail.lastHeight != null)) return@collectLatest
            // Geometry notifications can arrive during placement. Queue the
            // correction outside that pass; scrollToItem forces remeasurement.
            withContext(Dispatchers.Main) {
                if (!followsTail || isDragged) return@withContext
                correctingTail = true
                try {
                    // Includes the fixed history header. The large offset
                    // clamps to the end even for a multi-screen last message.
                    listState.scrollToItem(tail.lastIndex, Int.MAX_VALUE)
                } finally {
                    correctingTail = false
                }
            }
        }
    }
    LaunchedEffect(rows) {
        val live = rows.mapTo(mutableSetOf()) { it.id }
        heights.keys.retainAll(live)
        // Inspectors own their state; only retained transcript rows need leases here.
        val retained = live
        (stateKeys - retained).forEach(rowState::removeState)
        stateKeys.retainAll(retained)
        stateKeys.addAll(retained)
    }

    Box(modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().testTag("chat-transcript").layout { measurable, constraints ->
                // A same-key page can still resize rows. Reading the version
                // here forces a measure/placement pass even for a hidden-only
                // page; acknowledging composition alone is too early.
                val version = state.historyVersion
                val placeable = measurable.measure(constraints)
                layout(placeable.width, placeable.height) {
                    placeable.place(0, 0)
                    renderedHistoryVersion = version
                }
            },
            contentPadding = PaddingValues(vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom),
        ) {
            item(key = HISTORY_KEY, contentType = HISTORY_KEY) {
                HistoryControl(paging.phase, state.hasMore, state.isSyncingTail, onRetryHistory)
            }
            items(rows, key = { it.id }, contentType = { it.block.contentKind }) { row ->
                rowState.SaveableStateProvider(row.id) {
                    val rowModifier = Modifier
                        .onSizeChanged { heights[row.id] = it.height }
                        .testTag("chat-row-" + row.id)
                    app.hapi.companion.ui.theme.ReadingColumn(modifier = rowModifier) {
                        ChatBlockCard(block = row.block, basePath = state.basePath, processSteps = state.processSteps[row.id])
                    }
                }
            }
        }
        if (!followsTail || state.requiresLatestReset || jumpingLatest) {
            Surface(
                shape = androidx.compose.foundation.shape.CircleShape,
                tonalElevation = 4.dp,
                modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
            ) {
                TextButton(
                    onClick = onJumpToLatest, enabled = !jumpingLatest,
                    modifier = Modifier.testTag("chat-latest"),
                ) {
                    if (jumpingLatest) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.chat_back_to_latest))
                }
            }
        }
    }
}

private data class LayoutReport(
    val version: Long,
    val matches: Boolean,
    val short: Boolean,
    val nearTop: Boolean,
    val atBottom: Boolean,
    val scrolling: Boolean,
    val ownScroll: Boolean,
    val following: Boolean,
    val ids: Set<String>,
    val visibleHeight: Int,
)

private data class TailLayout(
    val lastIndex: Int,
    val itemCount: Int,
    val viewportHeight: Int,
    val lastHeight: Int?,
    val canScrollForward: Boolean,
    val messagesVersion: Long,
    val jumpToken: Long,
)

@Composable
private fun HistoryControl(
    phase: ChatHistoryPagingState.Phase,
    hasMore: Boolean,
    syncing: Boolean,
    onClick: () -> Unit,
) {
    val busy = phase == ChatHistoryPagingState.Phase.Loading ||
        phase == ChatHistoryPagingState.Phase.Retrying || phase is ChatHistoryPagingState.Phase.AwaitingLayout
    TextButton(
        onClick = onClick, enabled = hasMore && !busy && !syncing,
        modifier = Modifier.fillMaxWidth().height(44.dp).testTag("chat-history"),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (hasMore && busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Text(
                stringResource(when {
                    !hasMore -> R.string.chat_history_beginning
                    busy -> R.string.chat_loading_older
                    phase == ChatHistoryPagingState.Phase.Failed -> R.string.chat_history_retry
                    phase == ChatHistoryPagingState.Phase.Paused -> R.string.chat_history_continue
                    hasMore -> R.string.chat_history_load
                    else -> R.string.chat_history_beginning
                }),
                style = MaterialTheme.typography.labelSmall,
            )
        }
    }
}

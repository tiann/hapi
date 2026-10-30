package app.hapi.companion.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.sessions.SessionListSearch
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ConversationOutlineItem
import app.hapi.protocol.chat.formatOutlineTimestamp

/**
 * Entries whose label matches [query] (trimmed first). An empty or blank
 * query keeps everything; matching is case-insensitive and understands the
 * `*` and `?` wildcards — the same matcher the session list search uses.
 */
internal fun filterOutlineItems(
    items: List<ConversationOutlineItem>,
    query: String,
): List<ConversationOutlineItem> {
    val normalized = query.trim()
    if (normalized.isEmpty()) return items
    return items.filter { SessionListSearch.matchesSearchQuery(it.label, normalized) }
}

/**
 * Jump-to-message outline of the conversation: one row per user message in
 * the loaded window, newest last. The search field filters labels; the
 * "load earlier" row extends the window so older messages join the outline;
 * picking a row hands the entry to [onSelect], which scrolls the transcript
 * to that message.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun OutlinePanel(
    items: List<ConversationOutlineItem>,
    hasMore: Boolean,
    loadingMore: Boolean,
    onLoadMore: () -> Unit,
    onSelect: (ConversationOutlineItem) -> Unit,
    onDismiss: () -> Unit,
) {
    var searchQuery by rememberSaveable { mutableStateOf("") }
    val trimmedQuery = searchQuery.trim()
    val filtered = remember(items, trimmedQuery) { filterOutlineItems(items, trimmedQuery) }
    val languageTag = LocalConfiguration.current.locales[0].toLanguageTag()
    // Frozen when the sheet opens: the timestamp only needs a same-day
    // reference point, not a ticking clock.
    val nowMs = remember { System.currentTimeMillis() }
    val maxListHeight = LocalConfiguration.current.screenHeightDp.dp * 0.6f

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.outline_title),
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.outline_close),
                    )
                }
            }
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text(stringResource(R.string.outline_search_hint)) },
                leadingIcon = {
                    Icon(
                        Icons.Default.Search,
                        contentDescription = stringResource(R.string.outline_search_label),
                    )
                },
            )
            if (trimmedQuery.isNotEmpty()) {
                Text(
                    text = stringResource(
                        R.string.outline_search_results,
                        filtered.size,
                        items.size,
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.hapi.hint,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            LazyColumn(
                modifier = Modifier.fillMaxWidth().heightIn(max = maxListHeight),
            ) {
                if (hasMore) {
                    item(key = "outline-load-earlier") {
                        TextButton(
                            onClick = onLoadMore,
                            enabled = !loadingMore,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (loadingMore) {
                                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(
                                    Icons.Default.KeyboardArrowUp,
                                    contentDescription = null,
                                )
                            }
                            Text(
                                stringResource(R.string.outline_load_older),
                                modifier = Modifier.padding(start = 8.dp),
                            )
                        }
                    }
                }
                if (items.isEmpty()) {
                    item(key = "outline-empty") { OutlineEmptyLabel(R.string.outline_empty) }
                } else if (filtered.isEmpty()) {
                    item(key = "outline-no-results") {
                        OutlineEmptyLabel(R.string.outline_no_search_results)
                    }
                } else {
                    items(filtered, key = { it.id }) { item ->
                        OutlineEntryRow(
                            item = item,
                            languageTag = languageTag,
                            nowMs = nowMs,
                            onClick = { onSelect(item) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun OutlineEmptyLabel(labelRes: Int) {
    Text(
        text = stringResource(labelRes),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.hapi.hint,
        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
        textAlign = TextAlign.Center,
    )
}

/** One user message: timestamp with a marker dot, label capped at two lines. */
@Composable
private fun OutlineEntryRow(
    item: ConversationOutlineItem,
    languageTag: String,
    nowMs: Long,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            )
            Text(
                text = formatOutlineTimestamp(item.createdAt, languageTag, nowMs),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.hapi.hint,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = item.label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 12.dp, top = 2.dp),
        )
    }
}

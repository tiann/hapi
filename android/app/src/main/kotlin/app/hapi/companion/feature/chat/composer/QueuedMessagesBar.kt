package app.hapi.companion.feature.chat.composer

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.QueuedRowUi
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.hapi

/**
 * Queued (uninvoked) sends stacked above the composer — the Compose twin of
 * `QueuedMessagesBar.tsx`, styled like iOS `QueuedMessagesBarView`: one card
 * inset from the composer, one line per message. Steer (while a turn is
 * active) or Retry (unknown delivery) and Cancel are icon actions; tapping a
 * row edits it (cancel + prefill the composer); long-press lists every action
 * by name. Rows without a server echo yet (`id == localId`) keep their actions
 * disabled until the SSE echo lands.
 */
@Composable
fun QueuedMessagesBar(
    rows: List<QueuedRowUi>,
    onSteer: (messageId: String) -> Unit,
    onRetry: (messageId: String) -> Unit,
    onEdit: (messageId: String) -> Unit,
    onCancel: (messageId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (rows.isEmpty()) return

    val queuedLabel = if (rows.size == 1) {
        stringResource(R.string.chat_queued_one)
    } else {
        stringResource(R.string.chat_queued_many, rows.size)
    }
    Surface(
        color = MaterialTheme.hapi.composerSurface,
        shape = RoundedCornerShape(16.dp),
        border = BorderStroke(0.5.dp, MaterialTheme.hapi.divider),
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .padding(top = 4.dp)
            .semantics { contentDescription = queuedLabel }
            .testTag("chat-queued-card"),
    ) {
        Column(
            modifier = Modifier
                .animateContentSize()
                .heightIn(max = 168.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            rows.forEachIndexed { index, row ->
                key(row.id) {
                    // New rows slide in; removals collapse through the card's size animation.
                    val visible = remember { MutableTransitionState(false).apply { targetState = true } }
                    AnimatedVisibility(visibleState = visible, enter = fadeIn() + expandVertically()) {
                        Column {
                            if (index > 0) HorizontalDivider(color = MaterialTheme.hapi.divider, modifier = Modifier.padding(start = 40.dp))
                            QueuedRow(row, onSteer, onRetry, onEdit, onCancel)
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QueuedRow(
    row: QueuedRowUi,
    onSteer: (String) -> Unit,
    onRetry: (String) -> Unit,
    onEdit: (String) -> Unit,
    onCancel: (String) -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val editLabel = stringResource(R.string.chat_queued_edit)
    val secondary = MaterialTheme.hapi.textSecondary
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .combinedClickable(
                    enabled = row.canAct,
                    onClickLabel = editLabel,
                    onClick = { onEdit(row.id) },
                    onLongClick = { menuOpen = true },
                )
                .padding(start = 14.dp, end = 2.dp),
        ) {
            Icon(
                painterResource(R.drawable.ic_sym_subdirectory_arrow_right),
                contentDescription = null,
                tint = secondary,
                modifier = Modifier.size(16.dp),
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 10.dp, top = 6.dp, bottom = 6.dp),
            ) {
                Text(
                    text = row.text.ifEmpty { row.attachmentNames.joinToString(", ") },
                    style = HapiTypography.body.copy(fontSize = 15.sp, lineHeight = 20.sp),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (row.indeterminate) {
                    Text(
                        text = "Delivery outcome unknown",
                        style = HapiTypography.caption,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                row.scheduledAt?.let { scheduledAt ->
                    Text(
                        text = stringResource(
                            R.string.chat_queued_scheduled,
                            // Web `formatScheduledTime`: "Oct 25, 2:30 PM", the
                            // year only when it differs from the current one.
                            ScheduleSend.formatScheduledTime(scheduledAt),
                        ),
                        style = HapiTypography.caption,
                        color = secondary,
                    )
                }
            }
            if (row.indeterminate) {
                QueuedIconAction(R.drawable.ic_sym_refresh, stringResource(R.string.chat_retry), row.canAct) { onRetry(row.id) }
            } else if (row.canSteer) {
                QueuedIconAction(
                    R.drawable.ic_sym_bolt,
                    stringResource(R.string.chat_queued_steer),
                    enabled = true,
                    tint = MaterialTheme.colorScheme.primary,
                ) { onSteer(row.id) }
            }
            QueuedIconAction(R.drawable.ic_sym_close, stringResource(R.string.chat_cancel), row.canAct) { onCancel(row.id) }
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (row.indeterminate) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_retry)) },
                    enabled = row.canAct,
                    onClick = { menuOpen = false; onRetry(row.id) },
                )
            } else if (row.canSteer) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_queued_steer)) },
                    onClick = { menuOpen = false; onSteer(row.id) },
                )
            }
            DropdownMenuItem(
                text = { Text(editLabel) },
                enabled = row.canAct,
                onClick = { menuOpen = false; onEdit(row.id) },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.chat_cancel), color = MaterialTheme.colorScheme.error) },
                enabled = row.canAct,
                onClick = { menuOpen = false; onCancel(row.id) },
            )
        }
    }
}

@Composable
private fun QueuedIconAction(
    iconRes: Int,
    label: String,
    enabled: Boolean,
    tint: Color = MaterialTheme.hapi.textSecondary,
    onClick: () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                role = Role.Button
                if (!enabled) disabled()
            },
    ) {
        Icon(
            painterResource(iconRes),
            contentDescription = null,
            tint = if (enabled) tint else tint.copy(alpha = 0.38f),
            modifier = Modifier.size(18.dp),
        )
    }
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun QueuedMessagesBarPreview() {
    HapiTheme {
        Surface {
            QueuedMessagesBar(
                rows = listOf(
                    QueuedRowUi(
                        id = "m1", localId = "l1",
                        text = "Also add tests for the pagination edge cases",
                        attachmentNames = emptyList(),
                        scheduledAt = null, canAct = true, canSteer = true,
                    ),
                    QueuedRowUi(
                        id = "l2", localId = "l2",
                        text = "Waiting for server echo…",
                        attachmentNames = emptyList(),
                        scheduledAt = null, canAct = false, canSteer = false,
                    ),
                    QueuedRowUi(
                        id = "m3", localId = "l3",
                        text = "Ship it",
                        attachmentNames = listOf("notes.txt"),
                        scheduledAt = System.currentTimeMillis() + 3_600_000,
                        canAct = true, canSteer = false,
                    ),
                ),
                onSteer = {}, onRetry = {}, onEdit = {}, onCancel = {},
            )
        }
    }
}

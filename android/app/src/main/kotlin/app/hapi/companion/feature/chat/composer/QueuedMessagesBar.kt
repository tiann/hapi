package app.hapi.companion.feature.chat.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.QueuedRowUi
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import java.text.DateFormat
import java.util.Date

/**
 * Floating bar above the composer for queued (uninvoked) sends — the Compose
 * twin of `QueuedMessagesBar.tsx`. Per row: Steer (while a turn is active),
 * Edit (cancel + prefill composer) and Cancel. Rows without a server echo yet
 * (`id == localId`) keep their actions disabled until the SSE echo lands.
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

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = if (rows.size == 1) {
                stringResource(R.string.chat_queued_one)
            } else {
                stringResource(R.string.chat_queued_many, rows.size)
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.hapi.hint,
        )
        Column(
            modifier = Modifier
                .heightIn(max = 160.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            rows.forEach { row ->
                QueuedRow(row, onSteer, onRetry, onEdit, onCancel)
            }
        }
    }
}

@Composable
private fun QueuedRow(
    row: QueuedRowUi,
    onSteer: (String) -> Unit,
    onRetry: (String) -> Unit,
    onEdit: (String) -> Unit,
    onCancel: (String) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp, end = 2.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = row.text.ifEmpty { row.attachmentNames.joinToString(", ") },
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (row.indeterminate) {
                    Text(
                        text = "Delivery outcome unknown",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                row.scheduledAt?.let { scheduledAt ->
                    Text(
                        text = stringResource(
                            R.string.chat_queued_scheduled,
                            DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(scheduledAt)),
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.hapi.hint,
                    )
                }
            }
            if (row.indeterminate) {
                TextButton(onClick = { onRetry(row.id) }, enabled = row.canAct) { Text("Retry") }
            } else if (row.canSteer) {
                TextButton(onClick = { onSteer(row.id) }) { Text(stringResource(R.string.chat_queued_steer)) }
            }
            TextButton(onClick = { onEdit(row.id) }, enabled = row.canAct) { Text(stringResource(R.string.chat_queued_edit)) }
            TextButton(onClick = { onCancel(row.id) }, enabled = row.canAct) {
                Text(stringResource(R.string.chat_cancel), color = MaterialTheme.colorScheme.error)
            }
        }
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

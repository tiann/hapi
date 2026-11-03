package app.hapi.companion.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R

/**
 * Compact info affordance shown under a message card when the message
 * carries usage metadata (model / tokens / cost / timing).
 */
@Composable
internal fun MessageInfoEntry(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier
            .height(28.dp)
            .testTag("chat-message-info"),
        contentPadding = PaddingValues(horizontal = 8.dp),
    ) {
        Icon(
            Icons.Filled.Info,
            contentDescription = stringResource(R.string.chat_message_details),
            modifier = Modifier.size(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Message details popup: one pre-formatted metadata line per row.
 */
@Composable
internal fun MessageMetadataDialog(
    labels: List<String>,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_message_details)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                labels.forEach { label ->
                    Text(
                        label,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.chat_message_details_close))
            }
        },
    )
}

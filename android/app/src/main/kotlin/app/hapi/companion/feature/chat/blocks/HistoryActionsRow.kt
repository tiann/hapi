package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatHistoryGate
import app.hapi.companion.feature.chat.HistoryActionKind
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.messageHistoryActions

/**
 * The fork / rewind action row under a message bubble — the Android analogue
 * of the web `MessageActions` history cluster. Renders nothing unless the
 * session's [ChatHistoryGate] offers an action for this row (gating mirrors
 * `UserMessage.tsx` / `AssistantMessage.tsx` via [messageHistoryActions];
 * the whole cluster hides while locked, matching web `actionsLocked`).
 *
 * Buttons stay compact (`labelMedium`, tight padding) so the row reads as
 * message chrome, not a toolbar.
 */
@Composable
fun HistoryActionsRow(
    role: String,
    localId: String?,
    /** The block's thread key (`VisibleChatBlock.threadKey`). */
    blockKey: String,
    modifier: Modifier = Modifier,
) {
    val interactions = LocalChatInteractions.current ?: return
    val actions = messageHistoryActions(
        role = role,
        localId = localId,
        blockKey = blockKey,
        gate = interactions.historyGate,
    )
    if (actions.isEmpty) return
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        val fork = actions.fork
        if (fork != null) {
            TextButton(
                onClick = {
                    when (fork) {
                        HistoryActionKind.ForkCurrent -> interactions.requestForkCurrent()
                        // historical fork: hasNativePoint guarantees localId
                        HistoryActionKind.ForkAtMessage ->
                            localId?.let { interactions.requestForkAtMessage(it) }
                    }
                },
                contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 30.dp),
            ) {
                Text(
                    text = stringResource(R.string.chat_history_fork),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        if (actions.rewind) {
            TextButton(
                onClick = { localId?.let { interactions.requestRewind(it) } },
                contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 30.dp),
            ) {
                Text(
                    text = stringResource(R.string.chat_history_rewind),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
    }
}

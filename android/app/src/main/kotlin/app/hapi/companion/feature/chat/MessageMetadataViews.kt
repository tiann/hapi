package app.hapi.companion.feature.chat

import android.text.format.DateFormat
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.components.FullTextCopyIcon
import app.hapi.companion.ui.components.rememberFullTextCopy
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.VisibleChatBlock
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.util.Date

/**
 * The row closing one agent response (web `MessageActions`, start-aligned):
 * copy, details and time. Glyphs sit in 28dp circles whose 16dp artwork
 * lines up with the prose's leading edge; Compose extends their touch
 * bounds to the 48dp minimum without padding the transcript.
 */
@Composable
internal fun ResponseActions(
    footer: ResponseFooter,
    onShowDetails: (VisibleChatBlock) -> Unit,
    modifier: Modifier = Modifier,
) {
    val copy = footer.copyText?.let { rememberFullTextCopy(it, revertAfterMs = 1_500) }
    val details = footer.detailsBlock
    val leadsWithGlyph = copy != null || details != null
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .padding(top = if (leadsWithGlyph) 2.dp else 6.dp)
            .offset(x = if (leadsWithGlyph) (-6).dp else 0.dp)
            .testTag("chat-response-actions"),
    ) {
        if (copy != null) {
            ResponseActionGlyph(onClick = copy.invoke, enabled = !copy.busy, tag = "chat-message-copy") {
                val label = when {
                    copy.export -> copy.label
                    copy.copied -> stringResource(R.string.code_copied)
                    else -> stringResource(R.string.code_copy)
                }
                FullTextCopyIcon(copy, 16.dp, contentDescription = label)
            }
        }
        if (details != null) {
            ResponseActionGlyph(onClick = { onShowDetails(details) }, tag = "chat-message-info") {
                Icon(
                    painterResource(R.drawable.ic_sym_info),
                    contentDescription = stringResource(R.string.chat_message_details),
                    tint = MaterialTheme.hapi.textSecondary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Text(
            text = rememberMessageTimestamp(footer.timestamp),
            style = HapiTypography.caption.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.hapi.hint,
            modifier = Modifier
                .padding(start = if (leadsWithGlyph) 4.dp else 0.dp)
                .testTag("chat-message-time"),
        )
    }
}

@Composable
private fun ResponseActionGlyph(
    onClick: () -> Unit,
    tag: String,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(28.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .testTag(tag),
    ) { content() }
}

/** Which date fields a message timestamp shows (web `formatMessageTimestamp`). */
internal enum class MessageTimestampSkeleton(val skeleton: String) {
    /** Same calendar day: time only. */
    TIME("HHmm"),

    /** Same year: month, day and time. */
    MONTH_DAY("MMMdHHmm"),

    /** Older: the full date. */
    FULL("yMMMdHHmm"),
}

internal fun messageTimestampSkeleton(epochMs: Long, nowMs: Long, zone: ZoneId): MessageTimestampSkeleton {
    val date = Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    return when {
        date == today -> MessageTimestampSkeleton.TIME
        date.year == today.year -> MessageTimestampSkeleton.MONTH_DAY
        else -> MessageTimestampSkeleton.FULL
    }
}

/** Locale-ordered, always 24-hour (web uses `hourCycle: 'h23'`). */
@Composable
private fun rememberMessageTimestamp(epochMs: Long): String {
    val locale = LocalConfiguration.current.locales[0]
    val skeleton = messageTimestampSkeleton(epochMs, System.currentTimeMillis(), ZoneId.systemDefault())
    return remember(epochMs, locale, skeleton) {
        val pattern = DateFormat.getBestDateTimePattern(locale, skeleton.skeleton)
        SimpleDateFormat(pattern, locale).format(Date(epochMs))
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

package app.hapi.companion.feature.chat.share

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.hapi.companion.R
import app.hapi.protocol.chat.VisibleChatBlock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Compact share affordance shown under message cards that can anchor a
 * question-and-answer turn.
 */
@Composable
internal fun ShareTurnEntry(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier
            .height(28.dp)
            .testTag("chat-share-turn"),
        contentPadding = PaddingValues(horizontal = 8.dp),
    ) {
        Icon(
            Icons.Filled.Share,
            contentDescription = stringResource(R.string.chat_share_turn),
            modifier = Modifier.height(14.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Prepared card image plus the text fallback for the same turn. */
private data class PreparedCard(
    val imageFile: File,
    val image: Bitmap,
    val plainText: String,
)

/**
 * Share-one-turn dialog: renders the anchored question-and-answer turn to a
 * card image, previews it, and hands it to the system share panel. When the
 * image cannot be produced or no target accepts images, the turn's plain
 * text goes out instead.
 */
@Composable
internal fun ShareTurnDialog(
    target: VisibleChatBlock,
    blocks: List<VisibleChatBlock>,
    info: ShareTurnSessionInfo?,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val selection = remember(target, blocks) { ShareTurnSelection.selectTurnBlocks(blocks, target) }
    val segments = remember(selection) { ShareTurnSelection.shareableSegments(selection) }
    val plainText = remember(segments) { ShareTurnSelection.plainText(segments) }
    val title = info?.title.orEmpty().ifEmpty { ShareTurnFileNames.FALLBACK_TITLE }
    val caption = remember(info) {
        info?.let { buildCaption(context, it) }.orEmpty()
    }

    var prepared by remember(target, blocks, info) { mutableStateOf<PreparedCard?>(null) }
    var preparing by remember(target, blocks, info) { mutableStateOf(segments.isNotEmpty()) }
    var failure by remember(target, blocks, info) { mutableStateOf(false) }

    LaunchedEffect(target, blocks, info) {
        if (segments.isEmpty()) return@LaunchedEffect
        val outcome = withContext(Dispatchers.IO) {
            runCatching {
                val measurer = ShareCardBitmap.createMeasurer()
                val layout = ShareCardLayout.layoutShareCard(
                    title = title,
                    metadataLabels = caption,
                    segments = segments,
                    measurer = measurer,
                    metrics = ShareCardMetrics(width = ShareCardBitmap.CARD_WIDTH_PX.toFloat()),
                    footerText = context.getString(R.string.chat_share_turn_footer),
                )
                val bitmap = ShareCardBitmap.renderBitmap(layout)
                val fileName = ShareTurnFileNames.shareImageFileName(title, System.currentTimeMillis())
                val file = ShareCardBitmap.writePng(context, bitmap, fileName)
                PreparedCard(file, bitmap, plainText)
            }
        }
        prepared = outcome.getOrNull()
        preparing = false
        failure = outcome.isFailure
    }

    fun shareText() {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, plainText)
            putExtra(Intent.EXTRA_TITLE, title)
        }
        try {
            context.startActivity(Intent.createChooser(send, context.getString(R.string.chat_share_turn)))
        } catch (_: ActivityNotFoundException) {
            failure = true
        }
    }

    fun shareImage(card: PreparedCard) {
        try {
            val uri = FileProvider.getUriForFile(context, context.packageName + ".attachments", card.imageFile)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, title)
                clipData = ClipData.newRawUri("HAPI", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(send, context.getString(R.string.chat_share_turn)))
        } catch (_: ActivityNotFoundException) {
            shareText()
        } catch (_: Exception) {
            shareText()
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.chat_share_turn)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                when {
                    segments.isEmpty() -> Text(
                        stringResource(R.string.chat_share_turn_empty),
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    preparing -> Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        CircularProgressIndicator(Modifier.height(16.dp), strokeWidth = 2.dp)
                        Text(
                            stringResource(R.string.chat_share_turn_preparing),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }

                    else -> {
                        prepared?.let { card ->
                            Image(
                                bitmap = card.image.asImageBitmap(),
                                contentDescription = null,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .heightIn(max = 384.dp)
                                    .verticalScroll(rememberScrollState()),
                            )
                        }
                        if (failure) {
                            Text(
                                stringResource(R.string.chat_share_turn_error),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val card = prepared
                    when {
                        card != null -> shareImage(card)
                        segments.isNotEmpty() -> shareText()
                        else -> onDismiss()
                    }
                },
                enabled = segments.isNotEmpty() && !preparing,
            ) {
                Text(
                    stringResource(
                        if (preparing) R.string.chat_share_turn_preparing
                        else R.string.chat_share_turn_share,
                    ),
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.chat_message_details_close))
            }
        },
    )
}

/** Caption entries under the card title, with localized time wording. */
private fun buildCaption(context: Context, info: ShareTurnSessionInfo): List<String> {
    val now = System.currentTimeMillis()
    return ShareTurnMetadata.buildLabels(
        info = info,
        formatRelativeTime = { thenMs ->
            when (val bucket = ShareTurnMetadata.classifyRelativeTime(now, thenMs)) {
                ShareRelativeTime.JustNow -> context.getString(R.string.chat_share_turn_just_now)
                is ShareRelativeTime.MinutesAgo ->
                    context.getString(R.string.chat_share_turn_minutes_ago, bucket.minutes)

                is ShareRelativeTime.HoursAgo -> "${bucket.hours}h"
                is ShareRelativeTime.DaysAgo -> "${bucket.days}d"
                is ShareRelativeTime.AbsoluteDate -> ShareTurnMetadata.formatAbsoluteDate(bucket)
                null -> ""
            }
        },
        formatTimestamp = { thenMs ->
            ShareTurnMetadata.formatTimestamp(thenMs, java.time.ZoneId.systemDefault(), java.util.Locale.getDefault())
        },
    )
}

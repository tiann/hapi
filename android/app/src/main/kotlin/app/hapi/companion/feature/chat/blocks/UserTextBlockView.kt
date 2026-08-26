package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.attachments.PreviewImage
import app.hapi.companion.feature.chat.attachments.rememberPreviewImage
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.chat.ChatAttachment
import app.hapi.protocol.chat.UserTextBlock

/**
 * Operator prompt: right-aligned bubble (whitespace preserved — prompts are
 * not rendered as markdown, matching the web user bubble), attachments as
 * image thumbnails (decoded from the wire `previewUrl` data URL — both
 * Android- and web-sent messages carry one, and optimistic rows do too, so
 * thumbnails appear instantly on send) or filename chips, and a failed-send
 * tap-to-retry hint (B-M3f upgrades the former chips-only rendering).
 */
@Composable
fun UserTextBlockView(block: UserTextBlock, modifier: Modifier = Modifier) {
    val maxBubbleWidth = (LocalConfiguration.current.screenWidthDp * 0.85f).dp
    Row(modifier = modifier.fillMaxWidth()) {
        Spacer(modifier = Modifier.width(48.dp).weight(1f))
        Column(horizontalAlignment = Alignment.End) {
            Surface(
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp),
                modifier = Modifier.widthIn(max = maxBubbleWidth),
            ) {
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                    Text(
                        text = block.text,
                        style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 21.sp),
                    )
                    block.attachments?.takeIf { it.isNotEmpty() }?.let { attachments ->
                        Column(
                            modifier = Modifier.padding(top = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                            horizontalAlignment = Alignment.End,
                        ) {
                            attachments.forEach { AttachmentView(it) }
                        }
                    }
                }
            }
            if (block.status == "failed") {
                val interactions = LocalChatInteractions.current
                val retryLocalId = block.localId
                val retryModifier = if (interactions != null && retryLocalId != null) {
                    Modifier.clickable { interactions.retryFailedMessage(retryLocalId) }
                } else {
                    Modifier
                }
                Text(
                    text = stringResource(
                        if (interactions != null && retryLocalId != null) {
                            R.string.chat_not_delivered_retry
                        } else {
                            R.string.chat_not_delivered
                        },
                    ),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = retryModifier.padding(top = 2.dp, end = 4.dp),
                )
            }
        }
    }
}

/**
 * One bubble attachment: image mimes with a decodable `previewUrl` render a
 * thumbnail (web `MessageAttachments` split); everything else — plus decode
 * failures — falls back to the filename chip.
 */
@Composable
private fun AttachmentView(attachment: ChatAttachment) {
    val isImage = attachment.mimeType.startsWith("image/")
    if (!isImage || attachment.previewUrl == null) {
        AttachmentChip(attachment)
        return
    }
    val preview by rememberPreviewImage(attachment.previewUrl)
    when (val state = preview) {
        is PreviewImage.Ready -> Image(
            bitmap = state.bitmap,
            contentDescription = attachment.filename,
            contentScale = ContentScale.Fit,
            alignment = Alignment.CenterEnd,
            modifier = Modifier
                .heightIn(max = 180.dp)
                .clip(RoundedCornerShape(10.dp)),
        )
        // Sized placeholder while decoding keeps the bubble from jumping.
        PreviewImage.Loading -> Surface(
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.4f),
            shape = RoundedCornerShape(10.dp),
        ) {
            Spacer(modifier = Modifier.size(width = 120.dp, height = 90.dp))
        }
        PreviewImage.Unavailable -> AttachmentChip(attachment)
    }
}

@Composable
private fun AttachmentChip(attachment: ChatAttachment) {
    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.55f),
        shape = RoundedCornerShape(8.dp),
    ) {
        Text(
            text = "${if (attachment.mimeType.startsWith("image/")) "🖼" else "📎"} ${attachment.filename}",
            style = MaterialTheme.typography.labelMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun UserTextBlockPreview() {
    HapiTheme {
        Surface {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            UserTextBlockView(
                UserTextBlock(
                    id = "u1",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "Fix the failing pagination test and explain the root cause",
                    attachments = null,
                    status = null,
                    originalText = null,
                    meta = null,
                ),
            )
            UserTextBlockView(
                UserTextBlock(
                    id = "u2",
                    localId = null,
                    createdAt = 0,
                    invokedAt = null,
                    text = "Here is the screenshot",
                    attachments = listOf(
                        ChatAttachment(
                            id = "a1",
                            filename = "screenshot.png",
                            mimeType = "image/png",
                            size = 1024.0,
                            path = "/uploads/screenshot.png",
                        ),
                    ),
                    status = "failed",
                    originalText = null,
                    meta = null,
                ),
            )
            }
        }
    }
}

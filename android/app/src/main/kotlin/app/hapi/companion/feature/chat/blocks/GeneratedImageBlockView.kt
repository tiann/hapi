package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.hapi.companion.feature.chat.LocalChatMedia
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.GeneratedImageBlock
import coil.compose.AsyncImage

/**
 * Hub-generated image (`/api/sessions/:id/generated-images/:imageId`), loaded
 * through the per-hub authed Coil loader ([LocalChatMedia]). Tap opens a
 * simple full-screen viewer dialog. Without a loader (previews/tests) the
 * card degrades to a filename placeholder.
 */
@Composable
fun GeneratedImageBlockView(block: GeneratedImageBlock, modifier: Modifier = Modifier) {
    val media = LocalChatMedia.current
    val url = remember(block.imageId) { media.generatedImageUrl(block.imageId) }
    var viewerOpen by remember { mutableStateOf(false) }

    if (media.imageLoader == null || url == null) {
        Text(
            text = "🖼 ${block.fileName}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.hapi.hint,
            modifier = modifier.padding(vertical = 4.dp),
        )
        return
    }

    AsyncImage(
        model = url,
        imageLoader = media.imageLoader,
        contentDescription = block.fileName,
        contentScale = ContentScale.Fit,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(max = 360.dp)
            .clip(RoundedCornerShape(12.dp))
            .clickable { viewerOpen = true },
    )

    if (viewerOpen) {
        Dialog(
            onDismissRequest = { viewerOpen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.92f))
                    .clickable { viewerOpen = false },
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(
                    model = url,
                    imageLoader = media.imageLoader,
                    contentDescription = block.fileName,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(8.dp),
                )
            }
        }
    }
}

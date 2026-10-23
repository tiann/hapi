package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.clickable
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import app.hapi.companion.feature.chat.LocalChatMedia
import app.hapi.companion.ui.components.ZoomableImage
import app.hapi.companion.ui.components.ZoomableImageContent
import app.hapi.companion.ui.components.ZoomableImageViewerDialog
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.GeneratedImageBlock
import coil.compose.AsyncImage

/**
 * Hub-generated image (`/api/sessions/:id/generated-images/:imageId`), loaded
 * through the per-hub authed Coil loader ([LocalChatMedia]) — SVG documents
 * included, via the loader's `SvgDecoder`. Tap opens the shared zoomable
 * viewer (the web `ImagePreview` overlay). Without a loader (previews/tests)
 * the card degrades to a filename placeholder.
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
        ZoomableImageViewerDialog(
            images = listOf(ZoomableImage(ZoomableImageContent.Loaded(url, media.imageLoader), block.fileName)),
            onDismiss = { viewerOpen = false },
        )
    }
}

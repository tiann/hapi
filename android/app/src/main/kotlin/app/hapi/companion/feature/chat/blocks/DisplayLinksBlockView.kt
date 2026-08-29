package app.hapi.companion.feature.chat.blocks

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import app.hapi.companion.feature.chat.openUrl
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.DisplayLinksBlock

/**
 * Port of web `DisplayLinksCard`: tappable http(s) rows plus exact-copy strings.
 */
@Composable
fun DisplayLinksBlockView(block: DisplayLinksBlock, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val hasUrls = block.urls.isNotEmpty()
    val hasTexts = block.texts.isNotEmpty()
    val heading = when {
        hasUrls && hasTexts -> "Links & copy"
        hasTexts -> "Copy"
        else -> "Links"
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        tonalElevation = 1.dp,
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = heading,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
            )
            for (url in block.urls) {
                val urlTitle = url.title
                val navigable = runCatching {
                    val uri = url.href.toUri()
                    uri.scheme.equals("http", ignoreCase = true) ||
                        uri.scheme.equals("https", ignoreCase = true)
                }.getOrDefault(false)
                if (navigable) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { context.openUrl(url.href) }
                            .padding(10.dp),
                    ) {
                        Text(
                            text = urlTitle?.takeIf { it.isNotBlank() } ?: url.href,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!urlTitle.isNullOrBlank()) {
                            Text(
                                text = url.href,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.hapi.hint,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                } else {
                    Text(
                        text = urlTitle?.takeIf { it.isNotBlank() } ?: url.href,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.hapi.hint,
                    )
                }
            }
            for (text in block.texts) {
                val textTitle = text.title
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            val clip = ClipData.newPlainText(textTitle ?: "copy", text.value).apply {
                                description.extras = PersistableBundle().apply {
                                    putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                                }
                            }
                            clipboard.setPrimaryClip(clip)
                        }
                        .padding(10.dp),
                ) {
                    if (!textTitle.isNullOrBlank()) {
                        Text(
                            text = textTitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.hapi.hint,
                        )
                    }
                    Text(
                        text = text.value,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        text = "Tap to copy",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.hapi.hint,
                    )
                }
            }
        }
    }
}

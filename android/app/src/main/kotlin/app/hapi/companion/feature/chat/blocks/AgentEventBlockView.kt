package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.components.HapiBoxGlyph
import app.hapi.companion.ui.components.HapiClockGlyph
import app.hapi.companion.ui.components.HapiCloudGlyph
import app.hapi.companion.ui.components.HapiHourglassGlyph
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.AgentEvent
import app.hapi.protocol.chat.AgentEventBlock
import app.hapi.protocol.chat.getEventPresentation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Compact centered status row for the `'event'` family (ready / limits /
 * compaction / switch / errors / turn duration / …). Wording comes from the
 * shared protocol presentation (`getEventPresentation`, the web
 * `chat/presentation.ts` port); its icon field is emoji, which the web renders
 * as-is — Android maps it onto stroke glyphs here instead (rendering-layer
 * divergence; the protocol port itself stays faithful). Unknown icons render
 * text-only.
 */
@Composable
fun AgentEventBlockView(block: AgentEventBlock, modifier: Modifier = Modifier) {
    val presentation = remember(block) { getEventPresentation(block.event) }
    val glyph = presentation.icon?.let(::eventIcon)
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(
            verticalAlignment = Alignment.Top,
            modifier = Modifier
                .widthIn(max = 480.dp)
                .padding(horizontal = 24.dp, vertical = 2.dp),
        ) {
            glyph?.let { icon ->
                Icon(
                    imageVector = icon,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = MaterialTheme.hapi.hint,
                )
                Spacer(modifier = Modifier.width(4.dp))
            }
            Text(
                text = presentation.text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.hapi.hint,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Protocol emoji → vector glyph; null for unknown/absent icons. */
private fun eventIcon(icon: String): ImageVector? = when (icon) {
    "⚠️" -> Icons.Default.Warning
    "⏳" -> HapiHourglassGlyph
    "🔄" -> Icons.Default.Refresh
    "🔐" -> Icons.Default.Lock
    "📦" -> HapiBoxGlyph
    "💭" -> HapiCloudGlyph
    "◷", "⏱️" -> HapiClockGlyph
    else -> null
}

private fun previewEvent(vararg pairs: Pair<String, String>): AgentEvent =
    AgentEvent.of(JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

@Preview(showBackground = true)
@Composable
private fun AgentEventBlockPreview() {
    HapiTheme {
        Surface {
            Column(modifier = Modifier.padding(vertical = 8.dp)) {
                listOf(
                    previewEvent("type" to "switch", "mode" to "remote"),
                    previewEvent("type" to "compact"),
                    previewEvent("type" to "error", "message" to "Agent process exited unexpectedly"),
                    previewEvent("type" to "title-changed", "title" to "Pagination fix"),
                ).forEachIndexed { index, event ->
                    AgentEventBlockView(
                        AgentEventBlock(
                            id = "e$index",
                            createdAt = 0,
                            invokedAt = null,
                            event = event,
                            meta = null,
                        ),
                    )
                }
            }
        }
    }
}

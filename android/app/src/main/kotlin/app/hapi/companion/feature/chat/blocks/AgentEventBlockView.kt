package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.AgentEvent
import app.hapi.protocol.chat.AgentEventBlock
import app.hapi.protocol.chat.getEventPresentation
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Compact centered status row for the `'event'` family (ready / limits /
 * compaction / switch / errors / turn duration / …). Icon + wording come from
 * the shared protocol presentation (`getEventPresentation`, the web
 * `chat/presentation.ts` port); unknown event types fall back to its generic
 * raw rendering, truncated.
 */
@Composable
fun AgentEventBlockView(block: AgentEventBlock, modifier: Modifier = Modifier) {
    val presentation = remember(block) { getEventPresentation(block.event) }
    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(
            text = listOfNotNull(presentation.icon, presentation.text).joinToString(" "),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.hapi.hint,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .widthIn(max = 480.dp)
                .padding(horizontal = 24.dp, vertical = 2.dp),
        )
    }
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

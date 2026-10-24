package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.AgentReasoningBlock
import app.hapi.protocol.chat.AgentTextBlock

/** Assistant prose: full-width markdown (the shared M2d1 renderer). */
@Composable
fun AgentTextBlockView(block: AgentTextBlock, modifier: Modifier = Modifier) {
    Markdown(text = block.text, modifier = modifier.fillMaxWidth())
}

/**
 * Extended thinking, as a web-parity card: tinted surface with a header row
 * (chevron + label) that folds the full reasoning markdown away. Collapsed by
 * default and per-block. Unlike the web there is no streaming shimmer — the
 * Android block model has no "streaming" flag to key it on.
 */
@Composable
fun AgentReasoningBlockView(block: AgentReasoningBlock, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable(block.id) { mutableStateOf(false) }
    val hint = MaterialTheme.hapi.hint

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.hapi.reasoningBackground,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.animateContentSize()) {
            Row(
                modifier = Modifier
                    .clickable { expanded = !expanded }
                    .padding(start = 4.dp, top = 2.dp, bottom = 2.dp)
                    .heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(
                    imageVector = if (expanded) Icons.Default.KeyboardArrowDown
                    else Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = hint,
                )
                Text(
                    text = stringResource(R.string.chat_reasoning),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Medium,
                    color = hint,
                )
            }
            if (expanded) {
                HorizontalDivider(color = MaterialTheme.hapi.divider, modifier = Modifier.padding(horizontal = 14.dp))
                CompositionLocalProvider(LocalContentColor provides hint) {
                    Markdown(
                        text = block.text,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun AgentTextBlockPreview() {
    HapiTheme {
        Surface {
            Column(modifier = Modifier.padding(12.dp)) {
                AgentTextBlockView(
                    AgentTextBlock(
                        id = "a1",
                        localId = null,
                        createdAt = 0,
                        invokedAt = null,
                        text = "The failing test was a **cursor regression**:\n\n" +
                            "1. `beforeSeq` lost its `beforeAt` half\n" +
                            "2. the hub returned `reset: true`\n\n" +
                            "```kotlin\nval cursor = MessagePosition(at, seq)\n```",
                        meta = null,
                    ),
                )
                AgentReasoningBlockView(
                    AgentReasoningBlock(
                        id = "r1",
                        localId = null,
                        createdAt = 0,
                        invokedAt = null,
                        text = "The user wants pagination fixed. Let me check the cursor pair first…",
                        meta = null,
                    ),
                )
            }
        }
    }
}

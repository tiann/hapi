package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
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
 * Extended thinking: collapsed to a subdued one-liner by default, expands in
 * place to the full reasoning markdown (still subdued — it is meta-content).
 */
@Composable
fun AgentReasoningBlockView(block: AgentReasoningBlock, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable(block.id) { mutableStateOf(false) }
    val hint = MaterialTheme.hapi.hint

    Column(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(),
    ) {
        Row(
            modifier = Modifier
                .clickable { expanded = !expanded }
                .padding(vertical = 2.dp),
        ) {
            Text(
                text = stringResource(
                    if (expanded) R.string.chat_reasoning_expanded else R.string.chat_reasoning_collapsed,
                ),
                style = MaterialTheme.typography.labelMedium,
                color = hint,
            )
        }
        if (expanded) {
            CompositionLocalProvider(LocalContentColor provides hint) {
                Markdown(
                    text = block.text,
                    modifier = Modifier.padding(start = 8.dp, top = 4.dp),
                )
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

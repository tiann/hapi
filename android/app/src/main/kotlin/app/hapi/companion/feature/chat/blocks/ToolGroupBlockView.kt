package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolGroupSummary

/**
 * Run of adjacent groupable tools (web `ToolGroupCard`): a one-line summary —
 * count + first targets + error/running signals — expanding to the individual
 * [ToolCallBlockView]s. Codex exploration groups honor their `defaultOpen`.
 */
@Composable
fun ToolGroupBlockView(block: ToolGroupBlock, basePath: String?, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable(block.id) { mutableStateOf(block.defaultOpen) }
    val colors = MaterialTheme.hapi
    val summaryText = remember(block) { groupSummaryText(block) }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth().animateContentSize(),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text = "🔧", fontSize = 14.sp)
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = block.activityTitle
                            ?: if (block.summary.totalTools == 1) {
                                stringResource(R.string.chat_group_tools_one)
                            } else {
                                stringResource(R.string.chat_group_tools_many, block.summary.totalTools)
                            },
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (summaryText.isNotEmpty()) {
                        Text(
                            text = summaryText,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.hint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(modifier = Modifier.width(8.dp))
                if (block.summary.runningCount > 0) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                } else if (block.summary.errorCount > 0) {
                    Text(
                        text = "${block.summary.errorCount} ⚠",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else {
                    Text(
                        text = if (expanded) "▾" else "▸",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.hint,
                    )
                }
            }
            if (expanded) {
                Column(
                    modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    block.tools.forEach { tool ->
                        ToolCallBlockView(block = tool, basePath = basePath)
                    }
                }
            }
        }
    }
}

/** "file, other-file +2 · 1 command" style digest from the group summary. */
private fun groupSummaryText(block: ToolGroupBlock): String {
    val summary: ToolGroupSummary = block.summary
    val targets = (summary.fileTargets + summary.searchTargets + summary.commandTargets +
        summary.urlTargets + summary.otherTargets)
    if (targets.isEmpty()) return ""
    val shown = targets.take(3).joinToString(", ") { it.substringAfterLast('/').ifEmpty { it } }
    val more = targets.size - 3
    return if (more > 0) "$shown +$more" else shown
}

@Preview(showBackground = true)
@Composable
private fun ToolGroupBlockPreview() {
    HapiTheme {
        Surface {
            val tools = listOf(
                previewToolCall("g1", "Read", input = mapOf("file_path" to "web/src/chat/reducer.ts")),
                previewToolCall("g2", "Grep", input = mapOf("pattern" to "tailRevision")),
                previewToolCall("g3", "Bash", input = mapOf("command" to "bun test")),
            )
            ToolGroupBlockView(
                app.hapi.protocol.chat.buildVisibleChatBlocks(
                    tools,
                    app.hapi.protocol.chat.ToolGroupingOptions(hasMoreMessages = false),
                ).filterIsInstance<ToolGroupBlock>().first(),
                basePath = null,
                modifier = Modifier.padding(12.dp),
            )
        }
    }
}

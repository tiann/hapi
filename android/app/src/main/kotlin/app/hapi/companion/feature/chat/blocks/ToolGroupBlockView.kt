package app.hapi.companion.feature.chat.blocks

import android.content.res.Resources
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.protocol.chat.ToolGroupActionKind
import app.hapi.protocol.chat.ToolGroupBlock
import app.hapi.protocol.chat.ToolGroupSummary

/**
 * A group always occupies one transcript row; browsing belongs to the
 * inspector. Title leads with the activity and total calls; the subtitle
 * counts calls by kind ("3 reads · 1 command", iOS `categorySummary`).
 */
@Composable
fun ToolGroupBlockView(block: ToolGroupBlock, basePath: String?, modifier: Modifier = Modifier) {
    val inspection = app.hapi.companion.feature.chat.LocalChatInspection.current
    val resources = LocalContext.current.resources
    val total = if (block.summary.totalTools == 1) stringResource(R.string.chat_group_tools_one)
        else stringResource(R.string.chat_group_tools_many, block.summary.totalTools)
    val title = block.activityTitle?.let { "$it · $total" } ?: total
    val categories = remember(block.summary.countsByKind, resources) { groupCategorySummary(block.summary, resources) }
    val failedLabel = pluralStringResource(R.plurals.chat_group_failed, block.summary.errorCount, block.summary.errorCount)
    ToolCardSurface(modifier) {
        ToolSummaryLayout(
            icon = R.drawable.ic_sym_build,
            title = title,
            subtitle = categories.takeIf { it.isNotEmpty() },
            onClick = { inspection?.openGroup(block.id) },
        ) {
            if (block.summary.runningCount > 0) ToolStatusIndicator(app.hapi.protocol.chat.ToolState.RUNNING)
            if (block.summary.errorCount > 0) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = failedLabel },
                ) {
                    Icon(
                        painterResource(R.drawable.ic_sym_error), contentDescription = null,
                        tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(15.dp),
                    )
                    Text(
                        block.summary.errorCount.toString(),
                        style = HapiTypography.rowSubtitle.copy(fontWeight = FontWeight.Medium),
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(start = 2.dp),
                    )
                }
            }
        }
    }
}

private val CATEGORY_PLURALS = listOf(
    ToolGroupActionKind.READ to R.plurals.chat_group_reads,
    ToolGroupActionKind.SEARCH to R.plurals.chat_group_searches,
    ToolGroupActionKind.COMMAND to R.plurals.chat_group_commands,
    ToolGroupActionKind.MUTATION to R.plurals.chat_group_edits,
    ToolGroupActionKind.WEB to R.plurals.chat_group_web_requests,
    ToolGroupActionKind.OTHER to R.plurals.chat_group_other_tools,
)

internal fun groupCategorySummary(summary: ToolGroupSummary, resources: Resources): String =
    CATEGORY_PLURALS.mapNotNull { (kind, plural) ->
        val count = summary.countsByKind[kind] ?: 0
        if (count > 0) resources.getQuantityString(plural, count, count) else null
    }.joinToString(" · ")

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

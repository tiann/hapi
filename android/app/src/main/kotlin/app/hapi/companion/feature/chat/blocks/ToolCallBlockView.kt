package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.ToolState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Conversation summary; ordinary payloads and sidechains live in screen-owned
 * destinations. Plan proposals start expanded inline before approval controls
 * and retain explicit folding across input updates.
 */
@Composable
fun ToolCallBlockView(block: ToolCallBlock, basePath: String?, modifier: Modifier = Modifier, processSteps: Int? = null) {
    val tool = block.tool
    val resources = LocalContext.current.resources
    val presentation = remember(tool.name, tool.input, tool.description, basePath, resources) {
        app.hapi.companion.feature.chat.toolSummaryPresentation(tool, basePath, resources)
    }
    val inspection = app.hapi.companion.feature.chat.LocalChatInspection.current
    val steps = processSteps ?: block.children.size.takeIf { app.hapi.companion.feature.chat.opensToolProcess(block) }
    val planProposal = isPlanProposalTool(tool.name)
    // An output-first placeholder can acquire its real tool name later. Open a
    // newly recognized plan, but retain explicit folding across input updates.
    var expanded by rememberSaveable(block.id, planProposal) { mutableStateOf(planProposal) }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column {
            ToolSummaryRow(
                presentation, tool.state, expanded = expanded.takeIf { planProposal },
                onClick = {
                    if (planProposal) expanded = !expanded else inspection?.openTool(block.id)
                },
            )

            if (planProposal && expanded) {
                ToolCallBody(
                    tool = tool,
                    basePath = basePath,
                    modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                )
            }

            tool.permission?.let { permission ->
                val interactions = LocalChatInteractions.current
                if (permission.status == "pending" && interactions != null) {
                    Surface(color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.35f)) {
                        Column {
                            Text(
                                stringResource(R.string.chat_tool_awaiting_approval),
                                style = MaterialTheme.typography.labelLarge,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                            )
                            androidx.compose.material3.TextButton(onClick = { inspection?.openTool(block.id) }) {
                                Text(stringResource(R.string.chat_view_full_input))
                            }
                            PendingPermissionFooter(
                                tool = tool, requestId = permission.id, flavor = interactions.flavor,
                                override = interactions.permissionOverrides[permission.id],
                                onAction = interactions.resolvePermission,
                            )
                        }
                    }
                } else PermissionStateRow(permission)
            }
            if (steps != null) {
                androidx.compose.material3.TextButton(onClick = { inspection?.openTool(block.id) }) {
                    Text(stringResource(R.string.chat_view_process, steps))
                }
            }
        }
    }
}

@Composable
internal fun ToolSummaryRow(
    presentation: app.hapi.companion.feature.chat.ToolCardPresentation,
    state: String,
    expanded: Boolean? = null,
    onClick: () -> Unit,
) {
    val stacked = androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.5f
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .then(Modifier.heightIn(min = 48.dp)).padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(presentation.icon, modifier = Modifier.padding(end = 8.dp))
            Column(Modifier.weight(1f)) {
                Text(presentation.title, style = MaterialTheme.typography.bodyMedium, maxLines = if (stacked) 2 else 1, overflow = TextOverflow.Ellipsis)
                presentation.subtitle?.let {
                    Text(it, style = app.hapi.companion.ui.theme.HapiTypography.caption,
                        color = MaterialTheme.hapi.hint, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (!stacked) SummaryStatus(state, expanded)
        }
        if (stacked) SummaryStatus(state, expanded)
    }
}

@Composable
private fun SummaryStatus(state: String, expanded: Boolean?) {
    Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (state != ToolState.COMPLETED) ToolStatusIndicator(state)
        Text(if (expanded == true) "⌄" else "›", modifier = Modifier.padding(start = 8.dp), color = MaterialTheme.hapi.hint)
    }
}

@Composable
internal fun ToolStatusIndicator(state: String) {
    when (state) {
        ToolState.RUNNING -> CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 2.dp,
        )
        ToolState.PENDING -> StatusChip(
            text = stringResource(R.string.chat_tool_status_pending),
            container = MaterialTheme.colorScheme.surfaceContainerHigh,
            content = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        ToolState.ERROR -> StatusChip(
            text = stringResource(R.string.chat_tool_status_error),
            container = MaterialTheme.colorScheme.errorContainer,
            content = MaterialTheme.colorScheme.onErrorContainer,
        )
        else -> Text(
            text = "✓",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.hapi.hint,
        )
    }
}

@Composable
private fun StatusChip(text: String, container: androidx.compose.ui.graphics.Color, content: androidx.compose.ui.graphics.Color) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = content,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(container)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/**
 * Read-only permission verdict: highlighted banner while pending (renders
 * only without a [LocalChatInteractions] provider — previews/tests; the live
 * chat replaces it with [PendingPermissionFooter]), subdued line once decided.
 */
@Composable
private fun PermissionStateRow(permission: ToolPermission) {
    when (permission.status) {
        "pending" -> Surface(
            color = MaterialTheme.colorScheme.tertiaryContainer,
            contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                Text(
                    text = stringResource(R.string.chat_tool_awaiting_approval_badge),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
        "approved" -> PermissionLine(
            stringResource(R.string.chat_tool_approved) + (permission.mode?.let { " · $it" } ?: ""),
        )
        "denied" -> PermissionLine(
            stringResource(R.string.chat_tool_denied) + (permission.reason?.let { " · $it" } ?: ""),
            error = true,
        )
        "resolved" -> PermissionLine(stringResource(R.string.chat_tool_resolved))
        "canceled" -> PermissionLine(stringResource(R.string.chat_tool_canceled))
    }
}

@Composable
private fun PermissionLine(text: String, error: Boolean = false) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.hapi.hint,
        modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 6.dp),
    )
}

// -------------------------------------------------------------- previews --

internal fun previewToolCall(
    id: String,
    name: String,
    state: String = ToolState.COMPLETED,
    input: Map<String, String> = emptyMap(),
    permission: ToolPermission? = null,
): ToolCallBlock = ToolCallBlock(
    id = id,
    localId = null,
    createdAt = 0,
    invokedAt = null,
    tool = ChatToolCall(
        id = id,
        name = name,
        state = state,
        input = JsonObject(input.mapValues { (_, value) -> JsonPrimitive(value) }),
        createdAt = 0,
        description = null,
        permission = permission,
    ),
    children = emptyList(),
    meta = null,
)

@Preview(showBackground = true)
@Composable
private fun ToolCallBlockPreview() {
    HapiTheme {
        Surface {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ToolCallBlockView(
                    previewToolCall("t1", "Bash", ToolState.RUNNING, mapOf("command" to "bun test --watch")),
                    basePath = null,
                )
                ToolCallBlockView(
                    previewToolCall("t2", "Read", input = mapOf("file_path" to "/repo/web/src/chat/reducer.ts")),
                    basePath = "/repo",
                )
                ToolCallBlockView(
                    previewToolCall(
                        "t3",
                        "Bash",
                        ToolState.PENDING,
                        mapOf("command" to "rm -rf build"),
                        permission = ToolPermission(
                            id = "p1",
                            status = "pending",
                            presence = setOf("id", "status"),
                        ),
                    ),
                    basePath = null,
                )
            }
        }
    }
}

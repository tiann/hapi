package app.hapi.companion.feature.chat.blocks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.IntrinsicSize
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
import androidx.compose.ui.unit.sp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.ChatBlockCard
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.toolCardPresentation
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.ToolState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One tool invocation (web `ToolCard`): collapsed header row — icon glyph,
 * title, subtitle, status — expanding to the per-tool body ([ToolCallBody]),
 * the read-only permission state, and nested children (sidechain transcript).
 * Cards with a pending permission start expanded and carry the
 * "awaiting approval" banner (actions land in M3b).
 */
@Composable
fun ToolCallBlockView(block: ToolCallBlock, basePath: String?, modifier: Modifier = Modifier) {
    val tool = block.tool
    val resources = LocalContext.current.resources
    val presentation = remember(tool, basePath, resources) { toolCardPresentation(tool, basePath, resources) }
    val pendingPermission = tool.permission?.status == "pending"
    var expanded by rememberSaveable(block.id) { mutableStateOf(pendingPermission) }
    val colors = MaterialTheme.hapi

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
                Text(text = presentation.icon, fontSize = 14.sp)
                Spacer(modifier = Modifier.width(8.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = presentation.title,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    presentation.subtitle?.let { subtitle ->
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.hint,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(modifier = Modifier.width(8.dp))
                ToolStatusIndicator(tool.state)
            }

            tool.permission?.let { permission ->
                val interactions = LocalChatInteractions.current
                if (permission.status == "pending" && interactions != null) {
                    Surface(
                        color = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.35f),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column {
                            Text(
                                text = stringResource(R.string.chat_tool_awaiting_approval),
                                style = MaterialTheme.typography.labelLarge,
                                modifier = Modifier.padding(start = 10.dp, top = 6.dp),
                            )
                            PendingPermissionFooter(
                                tool = tool,
                                requestId = permission.id,
                                flavor = interactions.flavor,
                                override = interactions.permissionOverrides[permission.id],
                                onAction = interactions.resolvePermission,
                            )
                        }
                    }
                } else {
                    PermissionStateRow(permission)
                }
            }

            if (expanded) {
                ToolCallBody(
                    tool = tool,
                    basePath = basePath,
                    modifier = Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                )
            }

            if (block.children.isNotEmpty()) {
                ChildrenColumn(block, basePath, expanded)
            }
        }
    }
}

/** Sidechain children, nested behind an indent rail; collapsed to a count row. */
@Composable
private fun ChildrenColumn(block: ToolCallBlock, basePath: String?, parentExpanded: Boolean) {
    var childrenOpen by rememberSaveable("children:" + block.id) { mutableStateOf(parentExpanded) }
    val colors = MaterialTheme.hapi

    val stepsLabel = if (block.children.size == 1) {
        stringResource(R.string.chat_agent_steps_one)
    } else {
        stringResource(R.string.chat_agent_steps_many, block.children.size)
    }
    Text(
        text = (if (childrenOpen) "▾ " else "▸ ") + stepsLabel,
        style = MaterialTheme.typography.labelMedium,
        color = colors.hint,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { childrenOpen = !childrenOpen }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
    if (!childrenOpen) return

    Row(
        modifier = Modifier
            .padding(start = 12.dp, end = 8.dp, bottom = 10.dp)
            .height(IntrinsicSize.Min),
    ) {
        Spacer(
            modifier = Modifier
                .width(2.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(1.dp))
                .background(colors.divider),
        )
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            block.children.forEach { child ->
                ChatBlockCard(block = child, basePath = basePath)
            }
        }
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

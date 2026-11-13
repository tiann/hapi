package app.hapi.companion.feature.chat.blocks

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.companion.feature.chat.permissions.PermissionVerdictLabel
import app.hapi.companion.feature.chat.permissions.PermissionVerdicts
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
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
    if (isQuestionDetailsTool(block.tool.name)) {
        QuestionToolCard(block, modifier)
    } else {
        ActivityToolCard(block, basePath, modifier, processSteps)
    }
}

@Composable
private fun ActivityToolCard(block: ToolCallBlock, basePath: String?, modifier: Modifier, processSteps: Int?) {
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

    val pendingApproval = tool.permission?.takeIf { it.status == "pending" }
    val interactions = LocalChatInteractions.current

    ToolCardSurface(modifier) {
        Column {
            ToolSummaryRow(
                presentation, tool.state, expanded = expanded.takeIf { planProposal },
                // The approval section owns the pending state; a "pending"
                // chip beside "Awaiting approval" would repeat it (iOS showsStatus).
                showStatus = pendingApproval == null,
                onClick = {
                    if (planProposal) expanded = !expanded else inspection?.openTool(block.id)
                },
            )

            if (planProposal && expanded) {
                ToolCallBody(
                    tool = tool,
                    basePath = basePath,
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                )
            }

            if (planProposalMarkdown(tool) != null) {
                interactions?.let { CodexPlanActionsView(planId = tool.id, interactions = it) }
            }

            tool.permission?.let { permission ->
                if (pendingApproval != null && interactions != null) {
                    val override = interactions.permissionOverrides[permission.id]
                    ApprovalSection(
                        resolving = override == PermissionRowOverride.Resolving,
                        onViewInput = { inspection?.openTool(block.id) },
                    ) {
                        PendingPermissionFooter(
                            tool = tool, requestId = permission.id, flavor = interactions.flavor,
                            override = override,
                            onAction = interactions.resolvePermission,
                        )
                    }
                } else PermissionStateRow(permission, tool, interactions?.flavor)
            }
            if (steps != null) {
                ToolCardLink(
                    text = stringResource(R.string.chat_view_process, steps),
                    onClick = { inspection?.openTool(block.id) },
                )
            }
        }
    }
}

/** Neutral rounded card shared by tool, group and approval rows (iOS `theme.surface`). */
@Composable
internal fun ToolCardSurface(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.hapi.cardSurface,
        modifier = modifier.fillMaxWidth(),
        content = content,
    )
}

/**
 * Pending approval: a quiet status line (hourglass + caption, with the
 * full-input link on the same line) above the shared action buttons. While
 * submitting, a spinner takes the status icon's slot.
 */
@Composable
private fun ApprovalSection(resolving: Boolean, onViewInput: () -> Unit, actions: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        HorizontalDivider(color = MaterialTheme.hapi.divider, modifier = Modifier.padding(horizontal = 12.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp),
        ) {
            Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                if (resolving) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 1.5.dp,
                        color = MaterialTheme.hapi.textSecondary,
                    )
                } else {
                    Icon(
                        painterResource(R.drawable.ic_sym_hourglass_empty), contentDescription = null,
                        tint = MaterialTheme.hapi.warning, modifier = Modifier.size(16.dp),
                    )
                }
            }
            Text(
                stringResource(R.string.chat_tool_awaiting_approval),
                style = HapiTypography.rowSubtitle,
                color = MaterialTheme.hapi.textSecondary,
                modifier = Modifier.padding(start = 6.dp).weight(1f),
            )
            TextButton(onClick = onViewInput, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(stringResource(R.string.chat_view_full_input), style = HapiTypography.rowSubtitle)
                Icon(
                    painterResource(R.drawable.ic_sym_arrow_outward), contentDescription = null,
                    modifier = Modifier.padding(start = 2.dp).size(14.dp),
                )
            }
        }
        actions()
    }
}

/** Caption-sized navigation row inside a tool card ("View process · 4 steps ›"). */
@Composable
private fun ToolCardLink(text: String, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 40.dp)
            .padding(horizontal = 12.dp),
    ) {
        Text(
            text, style = HapiTypography.rowSubtitle, color = MaterialTheme.hapi.textSecondary,
            modifier = Modifier.weight(1f),
        )
        Icon(
            painterResource(R.drawable.ic_sym_chevron_right), contentDescription = null,
            tint = MaterialTheme.hapi.textSecondary, modifier = Modifier.size(18.dp),
        )
    }
}

/**
 * One tool summary: monochrome symbol, 15sp medium title (middle-truncated so
 * file names and command tails survive), one-line secondary subtitle, quiet
 * trailing status + chevron. Success shows nothing; running and errors stay
 * visible. At large font scales the status moves under the text.
 */
@Composable
internal fun ToolSummaryRow(
    presentation: app.hapi.companion.feature.chat.ToolCardPresentation,
    state: String,
    expanded: Boolean? = null,
    showStatus: Boolean = true,
    onClick: () -> Unit,
) {
    ToolSummaryLayout(
        icon = presentation.icon,
        title = presentation.title,
        subtitle = presentation.subtitle,
        expanded = expanded,
        onClick = onClick,
    ) {
        if (showStatus && state != ToolState.COMPLETED) ToolStatusIndicator(state)
    }
}

@Composable
internal fun ToolSummaryLayout(
    @DrawableRes icon: Int,
    title: String,
    subtitle: String?,
    expanded: Boolean? = null,
    onClick: () -> Unit,
    status: @Composable () -> Unit,
) {
    val stacked = LocalDensity.current.fontScale >= 1.5f
    val secondary = MaterialTheme.hapi.textSecondary
    Column(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.Top) {
                // Centered on the 20sp title line.
                Icon(
                    painterResource(icon), contentDescription = null, tint = secondary,
                    modifier = Modifier.padding(top = 2.dp, end = 10.dp).size(16.dp),
                )
                Column {
                    Text(
                        title, style = HapiTypography.rowTitle, color = MaterialTheme.colorScheme.onSurface,
                        maxLines = if (stacked) 2 else 1,
                        overflow = if (stacked) TextOverflow.Ellipsis else TextOverflow.MiddleEllipsis,
                    )
                    subtitle?.let {
                        Text(
                            it, style = HapiTypography.rowSubtitle, color = secondary,
                            maxLines = if (stacked) 2 else 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                }
            }
            if (!stacked) SummaryTrailing(expanded, status)
        }
        if (stacked) Row(Modifier.padding(start = 26.dp, top = 6.dp)) { SummaryTrailing(expanded, status) }
    }
}

@Composable
private fun SummaryTrailing(expanded: Boolean?, status: @Composable () -> Unit) {
    Row(
        Modifier.padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        status()
        Icon(
            painterResource(if (expanded == true) R.drawable.ic_sym_expand_more else R.drawable.ic_sym_chevron_right),
            contentDescription = null,
            tint = MaterialTheme.hapi.textSecondary,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** Running: neutral spinner. Error: red symbol + label. Pending: quiet chip. Success: a check (inspector only). */
@Composable
internal fun ToolStatusIndicator(state: String) {
    when (state) {
        ToolState.RUNNING -> CircularProgressIndicator(
            modifier = Modifier.size(14.dp),
            strokeWidth = 1.5.dp,
            color = MaterialTheme.hapi.textSecondary,
        )
        ToolState.PENDING -> StatusChip(
            text = stringResource(R.string.chat_tool_status_pending),
            tint = MaterialTheme.hapi.textSecondary,
        )
        ToolState.ERROR -> StatusChip(
            text = stringResource(R.string.chat_tool_status_error),
            tint = MaterialTheme.colorScheme.error,
            icon = R.drawable.ic_sym_error,
        )
        else -> Icon(
            painterResource(R.drawable.ic_sym_check),
            contentDescription = stringResource(R.string.chat_tool_status_done),
            tint = MaterialTheme.hapi.textSecondary,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun StatusChip(text: String, tint: Color, @DrawableRes icon: Int? = null) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(tint.copy(alpha = 0.12f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        icon?.let { Icon(painterResource(it), contentDescription = null, tint = tint, modifier = Modifier.padding(end = 3.dp).size(12.dp)) }
        Text(text = text, style = HapiTypography.caption.copy(fontWeight = FontWeight.Medium), color = tint)
    }
}

/**
 * Read-only permission verdict: a quiet status line while pending (renders
 * only without a [LocalChatInteractions] provider — previews/tests; the live
 * chat replaces it with [ApprovalSection]), a subdued icon + label once
 * decided. Settled labels come from [PermissionVerdicts.classify] — the web
 * `formatPermissionSummary` port covering codex/claude decision, mode and
 * allowedTools (`Bash(command)` qualifier) inference.
 */
@Composable
private fun PermissionStateRow(permission: ToolPermission, tool: ChatToolCall, flavor: String?) {
    if (permission.status == "pending") {
        PermissionLine(
            text = stringResource(R.string.chat_tool_awaiting_approval_badge),
            icon = R.drawable.ic_sym_hourglass_empty,
            tint = MaterialTheme.hapi.warning,
        )
        return
    }
    val verdict = remember(permission, tool.name, tool.input, flavor) {
        PermissionVerdicts.classify(permission, tool.name, tool.input, flavor)
    }
    val negative = verdict.label == PermissionVerdictLabel.DENIED || verdict.label == PermissionVerdictLabel.ABORTED
    PermissionLine(
        text = permissionVerdictLabel(verdict.label) + (verdict.reason?.let { " · $it" } ?: ""),
        icon = when (verdict.label) {
            PermissionVerdictLabel.DENIED, PermissionVerdictLabel.ABORTED -> R.drawable.ic_sym_cancel
            PermissionVerdictLabel.CANCELED -> R.drawable.ic_sym_close
            PermissionVerdictLabel.WAITING_FOR_APPROVAL -> R.drawable.ic_sym_hourglass_empty
            PermissionVerdictLabel.RESOLVED -> null
            else -> R.drawable.ic_sym_check_circle
        },
        tint = if (negative) MaterialTheme.colorScheme.error else MaterialTheme.hapi.textSecondary,
    )
}

@Composable
private fun permissionVerdictLabel(label: PermissionVerdictLabel): String = when (label) {
    PermissionVerdictLabel.WAITING_FOR_APPROVAL -> stringResource(R.string.chat_tool_awaiting_approval_badge)
    PermissionVerdictLabel.APPROVED -> stringResource(R.string.chat_tool_approved)
    PermissionVerdictLabel.APPROVED_FOR_SESSION -> stringResource(R.string.chat_tool_approved_for_session)
    PermissionVerdictLabel.APPROVED_ALLOW_ALL_EDITS -> stringResource(R.string.chat_tool_approved_allow_all_edits)
    PermissionVerdictLabel.DENIED -> stringResource(R.string.chat_tool_denied)
    PermissionVerdictLabel.ABORTED -> stringResource(R.string.chat_tool_aborted)
    PermissionVerdictLabel.CANCELED -> stringResource(R.string.chat_tool_canceled)
    PermissionVerdictLabel.RESOLVED -> stringResource(R.string.chat_tool_resolved)
    PermissionVerdictLabel.ALLOW -> stringResource(R.string.chat_perm_allow)
}

@Composable
private fun PermissionLine(text: String, @DrawableRes icon: Int?, tint: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
    ) {
        icon?.let { Icon(painterResource(it), contentDescription = null, tint = tint, modifier = Modifier.padding(end = 6.dp).size(14.dp)) }
        Text(text = text, style = HapiTypography.caption, color = tint)
    }
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

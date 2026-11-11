package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.PermissionAction
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.catalog.Flavors

/**
 * Pending-permission footers (B-M3b): the approval buttons for ordinary tool
 * permissions; AskUserQuestion / request_user_input reuse the inline
 * [QuestionAnswerFormView]. Flavor logic mirrors `PermissionFooter.tsx`:
 *
 * - codex family (incl. cursor and codex-dialect tool names): Allow
 *   (`decision: approved`) / Abort (`decision: abort`) + overflow
 *   Allow-for-session (`decision: approved_for_session`);
 * - everyone else: Allow (`{}`) / Deny (`{}`) + overflow Allow-for-session
 *   (claude: `allowTools`) and, for claude edit tools, Allow-all-edits
 *   (`mode: acceptEdits`).
 */
@Composable
fun PendingPermissionFooter(
    tool: ChatToolCall,
    requestId: String,
    flavor: String?,
    override: PermissionRowOverride?,
    onAction: (String, PermissionAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (isQuestionDetailsTool(tool.name)) {
        if (override == PermissionRowOverride.AlreadyHandled) {
            AlreadyHandledLine(modifier)
        } else {
            QuestionAnswerFormView(
                tool = tool,
                requestId = requestId,
                enabled = true,
                submitting = override == PermissionRowOverride.Resolving,
                openDetails = null,
                onSubmit = { action -> onAction(requestId, action) },
                modifier = modifier,
            )
        }
    } else {
        PermissionActionsRow(
            tool = tool,
            requestId = requestId,
            flavor = flavor,
            override = override,
            onAction = onAction,
            modifier = modifier,
        )
    }
}

/** `PermissionFooter.isCodexSession` twin (UI button-set selection). */
private fun isCodexUx(flavor: String?, toolName: String): Boolean =
    Flavors.isCodexFamily(flavor) || flavor == "cursor" ||
        toolName.startsWith("Codex") || toolName.startsWith("Gemini") ||
        toolName.startsWith("OpenCode") || toolName.startsWith("Copilot") ||
        toolName.startsWith("Cursor")

private val EDIT_TOOLS = setOf("Edit", "MultiEdit", "Write", "NotebookEdit")

private val HIDE_ALLOW_FOR_SESSION = EDIT_TOOLS +
    setOf("exit_plan_mode", "ExitPlanMode", "CursorCreatePlan")

@Composable
private fun PermissionActionsRow(
    tool: ChatToolCall,
    requestId: String,
    flavor: String?,
    override: PermissionRowOverride?,
    onAction: (String, PermissionAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (override == PermissionRowOverride.AlreadyHandled) {
        AlreadyHandledLine(modifier)
        return
    }
    val resolving = override == PermissionRowOverride.Resolving
    val codex = isCodexUx(flavor, tool.name)
    val canAllowForSession = !codex && tool.name !in HIDE_ALLOW_FOR_SESSION
    val canAllowAllEdits = flavor == "claude" && tool.name in EDIT_TOOLS
    var overflowOpen by remember { mutableStateOf(false) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedButton(
            onClick = { onAction(requestId, PermissionAction.Allow) },
            enabled = !resolving,
            modifier = Modifier.weight(1f),
        ) {
            Text(stringResource(R.string.chat_perm_allow), color = MaterialTheme.colorScheme.primary)
        }
        OutlinedButton(
            onClick = {
                onAction(requestId, if (codex) PermissionAction.Abort else PermissionAction.Deny)
            },
            enabled = !resolving,
            modifier = Modifier.weight(1f),
        ) {
            Text(
                stringResource(if (codex) R.string.chat_perm_abort else R.string.chat_perm_deny),
                color = MaterialTheme.colorScheme.error,
            )
        }
        if (resolving) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        } else if (codex || canAllowForSession || canAllowAllEdits) {
            Box {
                TextButton(onClick = { overflowOpen = true }) { Text("⋯") }
                DropdownMenu(expanded = overflowOpen, onDismissRequest = { overflowOpen = false }) {
                    if (codex || canAllowForSession) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_perm_allow_for_session)) },
                            onClick = {
                                overflowOpen = false
                                onAction(requestId, PermissionAction.AllowForSession)
                            },
                        )
                    }
                    if (canAllowAllEdits) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_perm_allow_all_edits)) },
                            onClick = {
                                overflowOpen = false
                                onAction(requestId, PermissionAction.AllowAllEdits)
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AlreadyHandledLine(modifier: Modifier = Modifier) {
    Text(
        text = stringResource(R.string.chat_perm_already_handled),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.hapi.hint,
        modifier = modifier.padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

// -------------------------------------------------------------- previews --

@Preview(showBackground = true)
@Composable
private fun PermissionActionsPreview() {
    HapiTheme {
        Surface {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PermissionActionsRow(
                    tool = previewToolCall("p1", "Bash", input = mapOf("command" to "rm -rf build")).tool,
                    requestId = "p1",
                    flavor = "claude",
                    override = null,
                    onAction = { _, _ -> },
                )
                PermissionActionsRow(
                    tool = previewToolCall("p2", "Edit", input = mapOf("file_path" to "/a/b.kt")).tool,
                    requestId = "p2",
                    flavor = "claude",
                    override = PermissionRowOverride.Resolving,
                    onAction = { _, _ -> },
                )
                PermissionActionsRow(
                    tool = previewToolCall("p3", "CodexBash", input = mapOf("command" to "ls")).tool,
                    requestId = "p3",
                    flavor = "codex",
                    override = null,
                    onAction = { _, _ -> },
                )
                PermissionActionsRow(
                    tool = previewToolCall("p4", "Bash").tool,
                    requestId = "p4",
                    flavor = "claude",
                    override = PermissionRowOverride.AlreadyHandled,
                    onAction = { _, _ -> },
                )
            }
        }
    }
}

package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.PermissionAction
import app.hapi.companion.feature.chat.PermissionRowOverride
import app.hapi.companion.feature.chat.permissions.AskQuestion
import app.hapi.companion.feature.chat.permissions.isCursorAskQuestionToolName
import app.hapi.companion.feature.chat.permissions.isRequestUserInputAnswered
import app.hapi.companion.feature.chat.permissions.parseAskUserQuestions
import app.hapi.companion.feature.chat.permissions.parseRequestUserInputQuestions
import app.hapi.companion.feature.chat.permissions.requestUserInputAnswerValues
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.isAskUserQuestionToolName
import app.hapi.protocol.chat.isRequestUserInputToolName
import app.hapi.protocol.catalog.Flavors

/**
 * Pending-permission footers (B-M3b): the approval buttons for ordinary tool
 * permissions plus the dedicated AskUserQuestion / request_user_input answer
 * forms. Flavor logic mirrors `PermissionFooter.tsx`:
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
    when {
        isAskUserQuestionToolName(tool.name) -> AskUserQuestionFooter(
            tool = tool,
            requestId = requestId,
            override = override,
            onAction = onAction,
            modifier = modifier,
        )
        isRequestUserInputToolName(tool.name) -> RequestUserInputFooter(
            tool = tool,
            requestId = requestId,
            override = override,
            onAction = onAction,
            modifier = modifier,
        )
        else -> PermissionActionsRow(
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

// ------------------------------------------------------- AskUserQuestion --

/**
 * AskUserQuestion answer form: every question as a card section — options as
 * tappable rows (radio/checkbox per `multiSelect`), an "Other" free-text
 * choice, one Submit. Answers post flat `{key: [labels…]}` where the key is
 * the index (or the Cursor stable id) — `AskUserQuestionFooter.tsx` parity.
 */
@Composable
private fun AskUserQuestionFooter(
    tool: ChatToolCall,
    requestId: String,
    override: PermissionRowOverride?,
    onAction: (String, PermissionAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (override == PermissionRowOverride.AlreadyHandled) {
        AlreadyHandledLine(modifier)
        return
    }
    val resolving = override == PermissionRowOverride.Resolving
    val cursorDialect = isCursorAskQuestionToolName(tool.name)
    val questions = remember(tool.id, tool.input) { parseAskUserQuestions(tool.input, cursorDialect) }

    // Selection state per question index.
    val selected = remember(tool.id) { mutableStateOf(mapOf<Int, Set<Int>>()) }
    val otherText = remember(tool.id) { mutableStateOf(mapOf<Int, String>()) }
    var validationError by remember(tool.id) { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (questions.isEmpty()) {
            // Fallback: free-text answer keyed "0" (web parity).
            OutlinedTextField(
                value = otherText.value[0].orEmpty(),
                onValueChange = { otherText.value = otherText.value + (0 to it) },
                enabled = !resolving,
                placeholder = { Text(stringResource(R.string.chat_perm_type_answer)) },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            questions.forEachIndexed { index, question ->
                AskQuestionSection(
                    question = question,
                    selectedIndices = selected.value[index] ?: emptySet(),
                    otherText = otherText.value[index].orEmpty(),
                    enabled = !resolving,
                    onToggleOption = { optionIndex ->
                        val current = selected.value[index] ?: emptySet()
                        val next = when {
                            question.multiSelect ->
                                if (optionIndex in current) current - optionIndex else current + optionIndex
                            else -> setOf(optionIndex)
                        }
                        selected.value = selected.value + (index to next)
                        validationError = null
                    },
                    onOtherText = { text ->
                        otherText.value = otherText.value + (index to text)
                        if (!question.multiSelect && text.isNotBlank()) {
                            selected.value = selected.value + (index to emptySet())
                        }
                        validationError = null
                    },
                )
            }
        }

        validationError?.let { error ->
            Text(
                text = error,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (resolving) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                val typeAnswerFirst = stringResource(R.string.chat_perm_type_answer_first)
                val answerEveryQuestion = stringResource(R.string.chat_perm_answer_all)
                TextButton(onClick = {
                    val answers = linkedMapOf<String, List<String>>()
                    if (questions.isEmpty()) {
                        val text = otherText.value[0].orEmpty().trim()
                        if (text.isEmpty()) {
                            validationError = typeAnswerFirst
                            return@TextButton
                        }
                        answers["0"] = listOf(text)
                    } else {
                        questions.forEachIndexed { index, question ->
                            val values = mutableListOf<String>()
                            (selected.value[index] ?: emptySet()).sorted().forEach { optionIndex ->
                                question.options.getOrNull(optionIndex)?.let { option ->
                                    values += if (cursorDialect) {
                                        option.id?.takeIf { it.isNotBlank() } ?: option.label
                                    } else {
                                        option.label
                                    }
                                }
                            }
                            otherText.value[index]?.trim()?.takeIf { it.isNotEmpty() }?.let { values += it }
                            if (values.isEmpty()) {
                                validationError = answerEveryQuestion
                                return@TextButton
                            }
                            answers[question.answerKey(index, cursorDialect)] = values
                        }
                    }
                    onAction(requestId, PermissionAction.FlatAnswers(answers))
                }) {
                    Text(stringResource(R.string.chat_perm_submit))
                }
            }
        }
    }
}

@Composable
private fun AskQuestionSection(
    question: AskQuestion,
    selectedIndices: Set<Int>,
    otherText: String,
    enabled: Boolean,
    onToggleOption: (Int) -> Unit,
    onOtherText: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        question.header?.let { header ->
            Text(
                text = header,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.hapi.hint,
            )
        }
        if (question.question.isNotEmpty()) {
            Text(text = question.question, style = MaterialTheme.typography.bodyMedium)
        }
        question.options.forEachIndexed { optionIndex, option ->
            val checked = optionIndex in selectedIndices
            Surface(
                shape = RoundedCornerShape(10.dp),
                color = if (checked) {
                    MaterialTheme.colorScheme.secondaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceContainerHigh
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .selectable(
                        selected = checked,
                        enabled = enabled,
                        onClick = { onToggleOption(optionIndex) },
                    ),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (question.multiSelect) {
                        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
                    } else {
                        RadioButton(selected = checked, onClick = null, enabled = enabled)
                    }
                    Column(modifier = Modifier.padding(start = 6.dp)) {
                        Text(text = option.label, style = MaterialTheme.typography.bodyMedium)
                        option.description?.let { description ->
                            Text(
                                text = description,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.hapi.hint,
                            )
                        }
                    }
                }
            }
        }
        OutlinedTextField(
            value = otherText,
            onValueChange = onOtherText,
            enabled = enabled,
            placeholder = { Text(stringResource(R.string.chat_perm_other)) },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

// ----------------------------------------------------- request_user_input --

/**
 * request_user_input answer form: per-field option rows plus a free-text
 * note; answers post nested `{fieldId: {answers: [labels…, "user_note: …"]}}`
 * (`RequestUserInputFooter.tsx` parity; the web-only URL confirmation flow is
 * not ported).
 */
@Composable
private fun RequestUserInputFooter(
    tool: ChatToolCall,
    requestId: String,
    override: PermissionRowOverride?,
    onAction: (String, PermissionAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (override == PermissionRowOverride.AlreadyHandled) {
        AlreadyHandledLine(modifier)
        return
    }
    val resolving = override == PermissionRowOverride.Resolving
    val questions = remember(tool.id, tool.input) { parseRequestUserInputQuestions(tool.input) }

    val selected = remember(tool.id) { mutableStateOf(mapOf<String, Set<String>>()) }
    val notes = remember(tool.id) {
        mutableStateOf(questions.associate { it.id to it.prefill.orEmpty() })
    }
    var validationError by remember(tool.id) { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        questions.forEach { question ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (question.question.isNotEmpty()) {
                    Text(
                        text = if (question.required) {
                            question.question
                        } else {
                            stringResource(R.string.chat_perm_optional_format, question.question)
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                question.options.forEach { option ->
                    val checked = option.label in (selected.value[question.id] ?: emptySet())
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = if (checked) {
                            MaterialTheme.colorScheme.secondaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceContainerHigh
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .selectable(selected = checked, enabled = !resolving, onClick = {
                                val current = selected.value[question.id] ?: emptySet()
                                val next = when {
                                    question.multiple ->
                                        if (option.label in current) current - option.label
                                        else current + option.label
                                    else -> setOf(option.label)
                                }
                                selected.value = selected.value + (question.id to next)
                                validationError = null
                            }),
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (question.multiple) {
                                Checkbox(checked = checked, onCheckedChange = null, enabled = !resolving)
                            } else {
                                RadioButton(selected = checked, onClick = null, enabled = !resolving)
                            }
                            Column(modifier = Modifier.padding(start = 6.dp)) {
                                Text(text = option.label, style = MaterialTheme.typography.bodyMedium)
                                option.description?.let { description ->
                                    Text(
                                        text = description,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.hapi.hint,
                                    )
                                }
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = notes.value[question.id].orEmpty(),
                    onValueChange = {
                        notes.value = notes.value + (question.id to it)
                        validationError = null
                    },
                    enabled = !resolving,
                    placeholder = { Text(question.placeholder ?: stringResource(R.string.chat_perm_add_note)) },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        validationError?.let { error ->
            Text(
                text = error,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (resolving) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            } else {
                val answerEveryRequired = stringResource(R.string.chat_perm_answer_required)
                TextButton(onClick = {
                    for (question in questions) {
                        val questionSelected = (selected.value[question.id] ?: emptySet()).toList()
                        val note = notes.value[question.id].orEmpty()
                        if (!isRequestUserInputAnswered(question, questionSelected, note)) {
                            validationError = answerEveryRequired
                            return@TextButton
                        }
                    }
                    val answers = linkedMapOf<String, List<String>>()
                    questions.forEach { question ->
                        answers[question.id] = requestUserInputAnswerValues(
                            selected = (selected.value[question.id] ?: emptySet()).toList(),
                            note = notes.value[question.id].orEmpty(),
                        )
                    }
                    onAction(requestId, PermissionAction.NestedAnswers(answers))
                }) {
                    Text(stringResource(R.string.chat_perm_submit))
                }
            }
        }
    }
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

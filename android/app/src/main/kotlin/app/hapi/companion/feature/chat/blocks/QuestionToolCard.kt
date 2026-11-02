package app.hapi.companion.feature.chat.blocks

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import app.hapi.companion.R
import app.hapi.companion.feature.chat.LocalChatInspection
import app.hapi.companion.feature.chat.LocalChatInteractions
import app.hapi.companion.feature.chat.PermissionAction
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.companion.ui.theme.HapiTypography
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.wire.HapiJson

/**
 * Questions are conversations, not permission approvals (iOS
 * `QuestionToolCard` twin). Pending questions own one inline step; settled
 * records collapse to a summary that opens the read-only inspector.
 */
@Composable
internal fun QuestionToolCard(block: ToolCallBlock, modifier: Modifier = Modifier) {
    val tool = block.tool
    val interactions = LocalChatInteractions.current
    val inspection = LocalChatInspection.current
    val details = remember(tool) { questionToolDetails(tool) }
    val permission = tool.permission
    val override = permission?.let { interactions?.permissionOverrides?.get(it.id) }
    val state = QuestionCardState.of(tool, details, override)
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth(),
    ) {
        if ((state == QuestionCardState.Answering || state == QuestionCardState.Submitting) && permission != null) {
            QuestionAnswerFormView(
                tool = tool,
                requestId = permission.id,
                enabled = interactions != null,
                submitting = state == QuestionCardState.Submitting,
                openDetails = inspection?.let { { it.openTool(block.id) } },
                onSubmit = { action -> interactions?.resolvePermission?.invoke(permission.id, action) },
            )
        } else {
            QuestionSummary(details, state, onClick = { inspection?.openTool(block.id) })
        }
    }
}

@Composable
private fun QuestionSummary(details: QuestionToolDetails, state: QuestionCardState, onClick: () -> Unit) {
    val otherLabel = stringResource(R.string.chat_perm_none_of_the_above)
    val emptyLabel = stringResource(R.string.chat_empty_snippet)
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 48.dp).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val (icon, tint) = when (state) {
                QuestionCardState.Answered -> Icons.Filled.CheckCircle to MaterialTheme.colorScheme.primary
                QuestionCardState.Handled -> Icons.Filled.CheckCircle to MaterialTheme.hapi.hint
                QuestionCardState.Canceled -> Icons.Filled.Close to MaterialTheme.hapi.hint
                QuestionCardState.Failed -> Icons.Filled.Warning to MaterialTheme.colorScheme.error
                else -> null to MaterialTheme.hapi.hint
            }
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            } else {
                Icon(painterResource(R.drawable.ic_help_outline), contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            }
            Text(
                text = stringResource(state.titleRes()),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(start = 8.dp).weight(1f),
            )
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                tint = MaterialTheme.hapi.hint, modifier = Modifier.size(18.dp),
            )
        }
        details.questions.forEach { question ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                val title = question.header ?: question.question
                if (title.isNotEmpty()) {
                    Text(
                        title, style = HapiTypography.caption, color = MaterialTheme.hapi.hint,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
                questionAnswerSummary(question, otherLabel, emptyLabel)?.let { answer ->
                    Text(
                        answer, style = MaterialTheme.typography.bodyMedium,
                        maxLines = if (details.questions.size == 1) 2 else 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

private fun QuestionCardState.titleRes(): Int = when (this) {
    QuestionCardState.Answered -> R.string.chat_question_answered
    QuestionCardState.Handled -> R.string.chat_question_handled
    QuestionCardState.Canceled -> R.string.chat_question_canceled
    QuestionCardState.Failed -> R.string.chat_question_failed
    QuestionCardState.Submitting -> R.string.chat_question_submitting
    QuestionCardState.Waiting, QuestionCardState.Answering -> R.string.chat_question_awaiting
}

/**
 * One question per page: options as selectable rows, an optional collapsed
 * note/other-answer field and a single primary action. Sign-in requests
 * (validated `input.url`) open the page together with submitting once the
 * confirmation option is selected — web's opener-null `window.open` analogue.
 */
@Composable
internal fun QuestionAnswerFormView(
    tool: ChatToolCall,
    requestId: String,
    enabled: Boolean,
    submitting: Boolean,
    openDetails: (() -> Unit)?,
    onSubmit: (PermissionAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val form = remember(tool.name, tool.input) { QuestionAnswerForm(tool) }
    var draft by rememberSaveable(requestId, stateSaver = QuestionAnswerDraft.Saver) { mutableStateOf(QuestionAnswerDraft()) }
    var error by remember(requestId) { mutableStateOf<String?>(null) }
    val focusManager = LocalFocusManager.current
    val textFocus = remember(requestId) { FocusRequester() }
    var focusRequests by remember(requestId) { mutableIntStateOf(0) }
    val context = LocalContext.current
    val interactive = enabled && !submitting
    val index = draft.currentPage(form)

    LaunchedEffect(focusRequests) { if (focusRequests > 0) runCatching { textFocus.requestFocus() } }
    LaunchedEffect(draft.page) { focusManager.clearFocus() }
    LaunchedEffect(submitting) { if (submitting) focusManager.clearFocus() }

    Column(modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val field = form.fields.getOrNull(index)
        FormHeader(field?.header, index, form.fields.size, openDetails, requestId)
        if (field == null) {
            Text(
                stringResource(R.string.chat_question_unavailable),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.hapi.hint,
            )
            return@Column
        }

        Column(Modifier.semantics { heading() }.testTag("question-prompt-$index")) {
            QuestionMarkdown(field.question.ifEmpty { stringResource(R.string.chat_perm_type_answer) })
        }
        val hints = listOfNotNull(
            if (field.multiple) stringResource(R.string.chat_question_select_all) else null,
            if (!field.required) stringResource(R.string.chat_question_optional) else null,
        )
        if (hints.isNotEmpty()) {
            Text(hints.joinToString(" · "), style = HapiTypography.caption, color = MaterialTheme.hapi.hint)
        }

        if (field.options.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                field.options.forEachIndexed { optionIndex, option ->
                    val other = field.isOtherOption(optionIndex)
                    QuestionSelectionRow(
                        label = if (other) stringResource(R.string.chat_perm_none_of_the_above) else option.label,
                        description = if (other) stringResource(R.string.chat_perm_other_note_optional) else option.description,
                        selected = optionIndex in draft.selected(index),
                        multiple = field.multiple,
                        enabled = interactive,
                        onClick = {
                            error = null
                            draft = draft.select(optionIndex, index, form)
                            if (other) focusRequests++ else focusManager.clearFocus()
                        },
                        modifier = Modifier.testTag("question-$index-choice-$optionIndex"),
                    )
                }
            }
        }

        val textLabel = textTitle(field)
        if (draft.showsText(index, form)) {
            OutlinedTextField(
                value = draft.text(index, form),
                onValueChange = {
                    error = null
                    draft = draft.withText(it, index, form)
                },
                enabled = interactive,
                placeholder = { Text(field.placeholder ?: textLabel) },
                textStyle = MaterialTheme.typography.bodyMedium,
                shape = RoundedCornerShape(10.dp),
                minLines = 2,
                maxLines = 6,
                modifier = Modifier.fillMaxWidth().focusRequester(textFocus).testTag("question-$index-text"),
            )
        }

        error?.let { Text(it, style = HapiTypography.caption, color = MaterialTheme.colorScheme.error) }

        val last = index == form.fields.lastIndex
        val submission = if (last) draft.submission(form)?.takeIf { form.isUrlConfirmed(draft) } else null
        val openFailed = stringResource(R.string.chat_perm_open_signin_failed)
        FlowRow(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (index > 0) {
                IconButton(
                    onClick = { draft = draft.previous(form) },
                    enabled = interactive,
                    modifier = Modifier.testTag("question-previous"),
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                        contentDescription = stringResource(R.string.chat_question_previous),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            if (field.options.isNotEmpty()) {
                val expanded = draft.showsText(index, form)
                TextButton(
                    onClick = {
                        draft = draft.toggleText(index, form)
                        if (draft.showsText(index, form)) focusRequests++ else focusManager.clearFocus()
                    },
                    enabled = interactive,
                    modifier = Modifier.testTag("question-$index-expand-text"),
                ) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.Add,
                        contentDescription = null, modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        if (expanded && !field.allowsCustomAnswer) stringResource(R.string.chat_question_hide_note) else textLabel,
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            Button(
                onClick = {
                    if (!last) {
                        draft = draft.next(form)
                        return@Button
                    }
                    val action = submission ?: return@Button
                    form.url?.let { url ->
                        if (!openSignInUrl(context, url)) {
                            error = openFailed
                            return@Button
                        }
                    }
                    onSubmit(action)
                },
                enabled = interactive && (if (last) submission != null else draft.isAnswered(index, form)),
                shape = RoundedCornerShape(10.dp),
                contentPadding = ButtonDefaults.ContentPadding,
                modifier = Modifier.heightIn(min = 44.dp).testTag(if (last) "question-submit" else "question-next"),
            ) {
                if (submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                Text(
                    stringResource(
                        when {
                            submitting -> R.string.chat_question_submitting
                            last -> R.string.chat_question_submit
                            else -> R.string.chat_question_next
                        },
                    ),
                )
            }
        }
    }
}

@Composable
private fun FormHeader(header: String?, index: Int, count: Int, openDetails: (() -> Unit)?, requestId: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            painterResource(R.drawable.ic_help_outline), contentDescription = null,
            tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp),
        )
        Text(
            header ?: stringResource(R.string.chat_question_your_answer),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.hapi.hint,
            modifier = Modifier.padding(start = 8.dp).weight(1f),
        )
        if (count > 1) {
            val a11y = stringResource(R.string.chat_question_progress_a11y, index + 1, count)
            Text(
                "${index + 1}/$count",
                style = HapiTypography.caption,
                color = MaterialTheme.hapi.hint,
                modifier = Modifier.padding(horizontal = 4.dp)
                    .clearAndSetSemantics { contentDescription = a11y }
                    .testTag("question-progress"),
            )
        }
        if (openDetails != null) {
            TextButton(onClick = openDetails, modifier = Modifier.testTag("question-details-$requestId")) {
                Text(stringResource(R.string.chat_question_details), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun textTitle(field: QuestionAnswerForm.Field): String = stringResource(
    when {
        field.options.isEmpty() -> R.string.chat_question_your_answer
        field.allowsCustomAnswer -> R.string.chat_question_other_answer
        else -> R.string.chat_perm_add_note
    },
)

@Composable
private fun QuestionSelectionRow(
    label: String,
    description: String?,
    selected: Boolean,
    multiple: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(10.dp)
    val accent = MaterialTheme.colorScheme.primary
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(if (selected) accent.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface, shape)
            .border(BorderStroke(1.dp, if (selected) accent else MaterialTheme.hapi.divider), shape)
            .selectable(selected = selected, enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Semantics belong to the row; null callbacks keep indicators passive.
        if (multiple) {
            Checkbox(checked = selected, onCheckedChange = null, enabled = enabled, modifier = Modifier.clearAndSetSemantics {})
        } else {
            RadioButton(selected = selected, onClick = null, enabled = enabled, modifier = Modifier.clearAndSetSemantics {})
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            QuestionOptionLabel(label)
            description?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = HapiTypography.caption, color = MaterialTheme.hapi.hint)
            }
        }
    }
}

@Composable
private fun QuestionOptionLabel(label: String) {
    val title = QuestionOptionTitle.of(label)
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title.text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        if (title.recommended) {
            Text(
                stringResource(R.string.chat_question_recommended),
                style = HapiTypography.caption,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), CircleShape)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

/** False (≈ web's popup-blocked return) when no handler takes the intent. */
private fun openSignInUrl(context: Context, url: String): Boolean = try {
    context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
    true
} catch (_: Exception) {
    false
}

// -------------------------------------------------------------- previews --

private fun previewQuestionTool(answers: String? = null): ToolCallBlock {
    val base = previewToolCall(
        "q1", "AskUserQuestion", state = if (answers == null) "running" else "completed",
        permission = ToolPermission(
            id = "q1", status = if (answers == null) "pending" else "approved", presence = emptySet(),
            answers = answers?.let(HapiJson::parseToJsonElement),
        ),
    )
    base.tool = base.tool.copy(
        input = HapiJson.parseToJsonElement(
            """{"questions":[{"header":"Deploy","question":"Where should this ship first?","options":[""" +
                """{"label":"Staging (Recommended)","description":"Safe for testing"},""" +
                """{"label":"Production","description":"Live traffic"}]}]}""",
        ),
    )
    return base
}

@Preview(showBackground = true)
@Composable
private fun QuestionToolCardPreview() {
    HapiTheme {
        Surface {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                QuestionAnswerFormView(
                    tool = previewQuestionTool().tool, requestId = "q1", enabled = true, submitting = false,
                    openDetails = {}, onSubmit = {},
                )
                QuestionToolCard(previewQuestionTool(answers = """{"0":["Staging (Recommended)"]}"""))
            }
        }
    }
}

package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.hapi

/** Static answer cards; no selection or submit callbacks, and no draft/prefill state. */
@Composable
internal fun QuestionDetailsView(questions: List<QuestionDetail>) {
    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        questions.forEachIndexed { index, question ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                question.header?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.hapi.hint) }
                if (question.question.isNotEmpty()) {
                    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.hapi.blockquoteBackground) {
                        Column(Modifier.fillMaxWidth().padding(10.dp)) { QuestionMarkdown(question.question) }
                    }
                }
                question.options.forEachIndexed { optionIndex, option ->
                    QuestionAnswerCard(
                        text = option.label, description = option.description, markdown = true,
                        isSelected = option.selected, multiple = question.multiple, showControl = question.hasAnswers,
                        modifier = Modifier.testTag("question-$index-option-$optionIndex"),
                    )
                }
                question.otherAnswers.forEach { answer ->
                    QuestionAnswerCard(
                        text = answer, caption = if (question.options.isEmpty()) null else stringResource(R.string.tool_custom_answer),
                        isSelected = true, multiple = question.multiple,
                    )
                }
                question.note?.let { note ->
                    QuestionAnswerCard(
                        text = note, caption = if (question.options.isEmpty()) null else stringResource(R.string.tool_answer_note),
                        isSelected = true, multiple = false,
                    )
                }
            }
        }
    }
}

@Composable
private fun QuestionAnswerCard(
    text: String,
    isSelected: Boolean,
    multiple: Boolean,
    modifier: Modifier = Modifier,
    description: String? = null,
    caption: String? = null,
    markdown: Boolean = false,
    showControl: Boolean = true,
) {
    Surface(
        shape = RoundedCornerShape(10.dp),
        color = if (isSelected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.hapi.divider),
        modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {
            if (showControl) selected = isSelected
        },
    ) {
        Row(Modifier.padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            if (showControl) {
                // Semantics belong to the card. Null callbacks keep indicators read-only.
                if (multiple) Checkbox(checked = isSelected, onCheckedChange = null, modifier = Modifier.clearAndSetSemantics {})
                else RadioButton(selected = isSelected, onClick = null, modifier = Modifier.clearAndSetSemantics {})
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                caption?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.hapi.hint) }
                when {
                    markdown -> QuestionMarkdown(text)
                    text.length > TOOL_TEXT_PAGE_SIZE -> ToolTextContent(code = text)
                    else -> Text(text.ifEmpty { stringResource(R.string.chat_empty_snippet) }, style = MaterialTheme.typography.bodyMedium)
                }
                description?.takeIf { it.isNotEmpty() }?.let { QuestionMarkdown(it) }
            }
        }
    }
}

@Composable
private fun QuestionMarkdown(text: String) {
    if (text.length > TOOL_TEXT_PAGE_SIZE) ToolTextContent(code = text, language = "markdown") else Markdown(text)
}

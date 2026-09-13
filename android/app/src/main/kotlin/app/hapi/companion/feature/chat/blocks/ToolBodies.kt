package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.terminalCommand
import app.hapi.companion.ui.components.DiffView
import app.hapi.companion.ui.markdown.Markdown
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.getInputString
import app.hapi.protocol.chat.getInputStringAny
import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.UnifiedDiffParser
import app.hapi.protocol.wire.HapiJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Expanded tool-card body: input rendering per tool kind + the result section
 * (the read-only slice of `web/src/components/ToolCard/views/`):
 *
 * - terminal family → command as a bash code block, stdout/stderr terminal-styled;
 * - `Edit`/`MultiEdit` structured edits → before/after code blocks (the web
 *   derives a word diff from `old_string`/`new_string`; ported minimally);
 * - `Write` → the written content as a code block;
 * - `CodexDiff` (and any input/result that parses as a unified diff) → [DiffView];
 * - `TodoWrite`/`update_plan` → checklist rows;
 * - `ExitPlanMode`/`exit_plan_mode` → complete Markdown proposal from input;
 * - Ask/RequestUserInput → questions + selected answers, read-only;
 * - anything else → pretty-printed JSON input, then the generic result.
 */
@Composable
internal fun ToolCallBody(tool: ChatToolCall, basePath: String?, modifier: Modifier = Modifier) {
    val questionTool = isQuestionDetailsTool(tool.name)
    val plan = planProposalMarkdown(tool)
    val answers = if (questionTool) tool.permission?.answers else null
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (questionTool) {
            QuestionToolBody(tool)
        } else if (plan != null) {
            // Plans are reading documents, never paged/truncated tool source.
            Markdown(text = plan)
            if (planProposalShowsResult(tool)) ToolResultSection(tool)
        } else {
            SectionLabel(stringResource(R.string.settings_usage_input))
            ToolInputSection(tool)
            ToolResultSection(tool)
        }
        var sourceExpanded by rememberSaveable(tool.id) { mutableStateOf(false) }
        if (tool.input != null || tool.result != null || answers != null) {
            TextButton(onClick = { sourceExpanded = !sourceExpanded }) {
                Text(stringResource(R.string.files_viewer_source))
            }
            if (sourceExpanded) {
                tool.input?.let {
                    SectionLabel(stringResource(R.string.settings_usage_input))
                    GenericJsonInput(it)
                }
                tool.result?.let {
                    SectionLabel(stringResource(R.string.chat_result))
                    GenericJsonInput(it)
                }
                answers?.let {
                    SectionLabel(stringResource(R.string.tool_question_answers))
                    GenericJsonInput(it)
                }
            }
        }
    }
}

@Composable
private fun QuestionToolBody(tool: ChatToolCall) {
    val details by produceState<QuestionToolDetails?>(null, tool) {
        value = withContext(Dispatchers.Default) { questionToolDetails(tool) }
    }
    val prepared = details
    if (prepared == null) {
        androidx.compose.material3.CircularProgressIndicator()
    } else {
        SectionLabel(stringResource(if (prepared.hasAnswers) R.string.tool_questions_answers else R.string.settings_usage_input))
        if (prepared.questions.isEmpty()) GenericJsonInput(tool.input)
        else QuestionDetailsView(prepared.questions)
        if (prepared.showResult) ToolResultSection(tool)
    }
}

// ------------------------------------------------------------------ input --

@Composable
private fun ToolInputSection(tool: ChatToolCall) {
    val input = tool.input
    val name = toolPresentationName(tool.name)
    when {
        name in TERMINAL_TOOLS -> {
            val command = terminalCommand(input)
            if (command != null) ToolTextContent(code = command, language = "bash") else GenericJsonInput(input)
        }

        name == "exec" -> {
            val source = toolSourceInput(input, listOf("code", "script"))
            if (source != null) ToolTextContent(code = source, language = "javascript") else GenericJsonInput(input)
        }

        name == "CodexPatch" -> {
            val patch = toolSourceInput(input, listOf("patch", "input", "command"))
            if (patch != null) ToolTextContent(code = patch, language = "diff") else GenericJsonInput(input)
        }

        name == "Edit" -> {
            val old = getInputString(input, "old_string")
            val new = getInputString(input, "new_string")
            if (old != null && new != null) {
                BeforeAfter(old, new, languageForPath(getInputStringAny(input, listOf("file_path", "path"))))
            } else {
                GenericJsonInput(input)
            }
        }

        name == "MultiEdit" -> {
            val language = languageForPath(getInputStringAny(input, listOf("file_path", "path")))
            val edits = (input as? JsonObject)?.get("edits") as? JsonArray
            if (!edits.isNullOrEmpty()) {
                edits.forEachIndexed { index, edit ->
                    val old = getInputString(edit, "old_string")
                    val new = getInputString(edit, "new_string")
                    if (old != null && new != null) {
                        if (edits.size > 1) {
                            SectionLabel(stringResource(R.string.chat_edit_n_of_m, index + 1, edits.size))
                        }
                        BeforeAfter(old, new, language)
                    } else {
                        GenericJsonInput(edit)
                    }
                }
            } else {
                GenericJsonInput(input)
            }
        }

        name == "Write" -> {
            val content = getInputStringAny(input, listOf("content", "text"))
            if (content != null) {
                ToolTextContent(
                    code = content,
                    language = languageForPath(getInputStringAny(input, listOf("file_path", "path"))),
                )
            } else {
                GenericJsonInput(input)
            }
        }

        name == "CodexDiff" -> {
            val unified = getInputString(input, "unified_diff")
            val files = remember(unified) { unified?.takeIf { fitsToolPage(it) }?.let(::tryParseDiff) }
            if (files != null) {
                files.forEach { DiffView(file = it) }
            } else if (unified != null) {
                ToolTextContent(code = unified, language = "diff")
            } else {
                GenericJsonInput(input)
            }
        }

        name == "TodoWrite" || name == "update_plan" -> {
            val items = checklistItems(input)
            if (items.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    items.forEach { (state, text) ->
                        Text(
                            text = "$state $text",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            } else {
                GenericJsonInput(input)
            }
        }

        name == "request_user_input_async" -> {
            QuestionsReadOnly(input)
        }

        else -> GenericJsonInput(input)
    }
}

@Composable
private fun BeforeAfter(old: String, new: String, language: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val emptyLabel = stringResource(R.string.chat_empty_snippet)
        SectionLabel(stringResource(R.string.chat_before))
        ToolTextContent(code = old.ifEmpty { emptyLabel }, language = language)
        SectionLabel(stringResource(R.string.chat_after))
        ToolTextContent(code = new.ifEmpty { emptyLabel }, language = language)
    }
}

@Composable
private fun GenericJsonInput(input: JsonElement?) {
    when {
        input == null || input is JsonNull -> Unit
        input is JsonPrimitive && input.isString -> ToolTextContent(code = input.content, language = null)
        else -> {
            val text by produceState<String?>(null, input) {
                value = null
                value = withContext(Dispatchers.Default) { prettyJson(input) }
            }
            text?.let { ToolTextContent(code = it, language = "json") }
        }
    }
}

@Composable
private fun QuestionsReadOnly(input: JsonElement?) {
    val questions = (input as? JsonObject)?.get("questions") as? JsonArray
    if (questions.isNullOrEmpty()) {
        GenericJsonInput(input)
        return
    }
    val hint = MaterialTheme.hapi.hint
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questions.forEach { entry ->
            val question = entry as? JsonObject
            if (question == null || getInputStringAny(question, listOf("question", "title")) == null) {
                GenericJsonInput(entry)
                return@forEach
            }
            val header = (question["header"] as? JsonPrimitive)?.contentOrNullIfNotString()
            val text = getInputStringAny(question, listOf("question", "title"))
            Column {
                header?.let {
                    Text(text = it, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                }
                text?.let {
                    Text(text = it, style = MaterialTheme.typography.bodyMedium)
                }
                val options = question["options"] as? JsonArray
                options?.forEach { option ->
                    Text(
                        text = "◦ ${toolQuestionOptionText(option)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = hint,
                        modifier = Modifier.padding(start = 8.dp, top = 2.dp),
                    )
                }
            }
        }
    }
}

// ----------------------------------------------------------------- result --

/** How a tool result renders: parsed diff > extracted text > pretty JSON. */
internal sealed interface ResultRendering {
    data class Diffs(val files: List<DiffFile>) : ResultRendering
    data class Terminal(val text: String) : ResultRendering
    data class Json(val pretty: String) : ResultRendering
    data class Code(val text: String, val language: String?) : ResultRendering
    data class Prose(val text: String) : ResultRendering
}

@Composable
private fun ToolResultSection(tool: ChatToolCall) {
    val result = tool.result ?: return
    if (result is JsonNull) return
    val isError = tool.state == "error"
    val rendering by produceState<ResultRendering?>(null, tool) {
        value = withContext(Dispatchers.Default) { resultRendering(tool) }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel(
            stringResource(if (isError) R.string.chat_result_error else R.string.chat_result),
        )
        val metadata = remember(result) { toolResultMetadata(result) }
        if (metadata.isNotEmpty()) SectionLabel(metadata.joinToString(" · "))
        when (val rendering = rendering) {
            is ResultRendering.Diffs -> rendering.files.forEach { DiffView(file = it) }
            is ResultRendering.Terminal -> ToolTextContent(code = rendering.text, terminal = true, isError = isError)
            is ResultRendering.Json -> ToolTextContent(code = rendering.pretty, language = "json")
            is ResultRendering.Code -> ToolTextContent(code = rendering.text, language = rendering.language)
            is ResultRendering.Prose -> Markdown(text = rendering.text)
            null -> Unit
        }
    }
}

internal fun resultRendering(tool: ChatToolCall): ResultRendering? {
    val result = tool.result ?: return null
    if (result is JsonNull) return null
    val text = extractResultText(result)
    if (text != null) {
        if (text.isBlank()) return null
        return when (val style = toolResultStyle(tool)) {
            is ToolResultStyle.Code -> ResultRendering.Code(text, style.language)
            ToolResultStyle.Markdown -> if (fitsToolPage(text)) ResultRendering.Prose(text)
                else ResultRendering.Code(text, "markdown")
            ToolResultStyle.Terminal -> {
                if (tool.state != "error" && fitsToolPage(text)) {
                    tryParseDiff(text)?.let { return ResultRendering.Diffs(it) }
                }
                ResultRendering.Terminal(text)
            }
        }
    }
    return ResultRendering.Json(prettyJson(result))
}

// ---------------------------------------------------------------- helpers --

private val DIFF_MARKER = Regex("(^|\n)@@ -\\d")
private val DIFF_HEADER = Regex("(^|\n)(diff --git |--- )")

/** Parse [text] as a unified diff when it plausibly is one. */
internal fun tryParseDiff(text: String): List<DiffFile>? {
    if (!DIFF_MARKER.containsMatchIn(text) || !DIFF_HEADER.containsMatchIn(text)) return null
    val files = UnifiedDiffParser.parse(text)
    return files.takeIf { parsed -> parsed.isNotEmpty() && parsed.any { it.hunks.isNotEmpty() || it.isBinary } }
}

private val prettyJsonFormat = Json(from = HapiJson) { prettyPrint = true }

internal fun prettyJson(element: JsonElement): String =
    prettyJsonFormat.encodeToString(JsonElement.serializer(), element)

private val EXTENSION_LANGUAGES = mapOf(
    "kt" to "kotlin", "kts" to "kotlin", "java" to "java", "ts" to "typescript",
    "tsx" to "typescript", "js" to "javascript", "jsx" to "javascript", "py" to "python",
    "rb" to "ruby", "go" to "go", "rs" to "rust", "swift" to "swift", "c" to "c",
    "h" to "c", "cpp" to "cpp", "cc" to "cpp", "cs" to "csharp", "sh" to "shell",
    "bash" to "shell", "json" to "json", "yml" to "yaml", "yaml" to "yaml",
    "cjs" to "javascript", "mjs" to "javascript", "mts" to "typescript", "cts" to "typescript",
    "toml" to "toml", "zsh" to "shell", "diff" to "diff", "patch" to "diff",
    "xml" to "xml", "html" to "html", "css" to "css", "md" to "markdown", "sql" to "sql",
)

internal fun languageForPath(path: String?): String? {
    val name = path?.replace('\\', '/')?.substringAfterLast('/')?.lowercase() ?: return null
    if (name == "dockerfile") return "dockerfile"
    if (name == "makefile") return "makefile"
    if (name.startsWith('.') && name.count { it == '.' } == 1) return null
    return EXTENSION_LANGUAGES[name.substringAfterLast('.', missingDelimiterValue = "")]
}

private fun JsonPrimitive.contentOrNullIfNotString(): String? = if (isString) content else null

/** `(glyph, text)` rows for TodoWrite `todos` / update_plan `plan` items. */
private fun checklistItems(input: JsonElement?): List<Pair<String, String>> {
    val obj = input as? JsonObject ?: return emptyList()
    val array = (obj["todos"] as? JsonArray) ?: (obj["plan"] as? JsonArray) ?: return emptyList()
    return array.mapNotNull { entry ->
        val item = entry as? JsonObject ?: return@mapNotNull null
        val content = (item["content"] as? JsonPrimitive)?.contentOrNullIfNotString()
            ?: (item["step"] as? JsonPrimitive)?.contentOrNullIfNotString()
            ?: return@mapNotNull null
        val status = (item["status"] as? JsonPrimitive)?.contentOrNullIfNotString()
        val glyph = when (status) {
            "completed", "complete", "done" -> "☑"
            "in_progress" -> "◐"
            else -> "☐"
        }
        glyph to content
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.hapi.hint,
    )
}

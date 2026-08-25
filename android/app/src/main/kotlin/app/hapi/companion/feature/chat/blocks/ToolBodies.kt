package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.feature.chat.displayPath
import app.hapi.companion.feature.chat.terminalCommand
import app.hapi.companion.ui.components.DiffView
import app.hapi.companion.ui.markdown.CodeBlock
import app.hapi.companion.ui.theme.hapi
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.getInputString
import app.hapi.protocol.chat.getInputStringAny
import app.hapi.protocol.chat.isAskUserQuestionToolName
import app.hapi.protocol.chat.isRequestUserInputToolName
import app.hapi.protocol.git.DiffFile
import app.hapi.protocol.git.UnifiedDiffParser
import app.hapi.protocol.wire.HapiJson
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
 * - Ask/RequestUserInput → questions + options, read-only;
 * - anything else → pretty-printed JSON input, then the generic result.
 */
@Composable
internal fun ToolCallBody(tool: ChatToolCall, basePath: String?, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ToolInputSection(tool, basePath)
        ToolResultSection(tool)
    }
}

// ------------------------------------------------------------------ input --

@Composable
private fun ToolInputSection(tool: ChatToolCall, basePath: String?) {
    val input = tool.input
    when {
        tool.name in TERMINAL_TOOLS -> {
            terminalCommand(input)?.let { command ->
                CodeBlock(code = command, language = "bash")
            }
        }

        tool.name == "Edit" -> {
            val old = getInputString(input, "old_string")
            val new = getInputString(input, "new_string")
            if (old != null && new != null) {
                BeforeAfter(old, new, languageForPath(getInputStringAny(input, listOf("file_path", "path"))))
            } else {
                GenericJsonInput(input)
            }
        }

        tool.name == "MultiEdit" -> {
            val language = languageForPath(getInputStringAny(input, listOf("file_path", "path")))
            val edits = (input as? JsonObject)?.get("edits") as? JsonArray
            if (edits != null) {
                edits.forEachIndexed { index, edit ->
                    val old = getInputString(edit, "old_string")
                    val new = getInputString(edit, "new_string")
                    if (old != null && new != null) {
                        if (edits.size > 1) {
                            SectionLabel(stringResource(R.string.chat_edit_n_of_m, index + 1, edits.size))
                        }
                        BeforeAfter(old, new, language)
                    }
                }
            } else {
                GenericJsonInput(input)
            }
        }

        tool.name == "Write" -> {
            val content = getInputStringAny(input, listOf("content", "text"))
            if (content != null) {
                CodeBlock(
                    code = content,
                    language = languageForPath(getInputStringAny(input, listOf("file_path", "path"))),
                )
            } else {
                GenericJsonInput(input)
            }
        }

        tool.name == "CodexDiff" -> {
            val unified = getInputString(input, "unified_diff")
            val files = unified?.let(::tryParseDiff)
            if (files != null) {
                files.forEach { DiffView(file = it) }
            } else {
                GenericJsonInput(input)
            }
        }

        tool.name == "TodoWrite" || tool.name == "update_plan" -> {
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

        isAskUserQuestionToolName(tool.name) || isRequestUserInputToolName(tool.name) -> {
            QuestionsReadOnly(input)
        }

        tool.name == "Read" || tool.name == "NotebookRead" || tool.name == "LS" -> {
            // The title already carries the path; nothing else worth echoing.
            getInputStringAny(input, listOf("file_path", "path", "notebook_path"))?.let { path ->
                SectionLabel(displayPath(path, basePath))
            }
        }

        else -> GenericJsonInput(input)
    }
}

@Composable
private fun BeforeAfter(old: String, new: String, language: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val emptyLabel = stringResource(R.string.chat_empty_snippet)
        SectionLabel(stringResource(R.string.chat_before))
        CodeBlock(code = old.ifEmpty { emptyLabel }, language = language)
        SectionLabel(stringResource(R.string.chat_after))
        CodeBlock(code = new.ifEmpty { emptyLabel }, language = language)
    }
}

@Composable
private fun GenericJsonInput(input: JsonElement?) {
    when {
        input == null || input is JsonNull -> Unit
        input is JsonPrimitive && input.isString -> CodeBlock(code = input.content, language = null)
        else -> CodeBlock(code = prettyJson(input), language = "json")
    }
}

@Composable
private fun QuestionsReadOnly(input: JsonElement?) {
    val questions = (input as? JsonObject)?.get("questions") as? JsonArray ?: return
    val hint = MaterialTheme.hapi.hint
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questions.forEach { entry ->
            val question = entry as? JsonObject ?: return@forEach
            val header = (question["header"] as? JsonPrimitive)?.contentOrNullIfNotString()
            val text = (question["question"] as? JsonPrimitive)?.contentOrNullIfNotString()
            Column {
                header?.let {
                    Text(text = it, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                }
                text?.let {
                    Text(text = it, style = MaterialTheme.typography.bodyMedium)
                }
                val options = question["options"] as? JsonArray
                options?.forEach { option ->
                    val label = when (option) {
                        is JsonPrimitive -> option.contentOrNullIfNotString()
                        is JsonObject -> (option["label"] as? JsonPrimitive)?.contentOrNullIfNotString()
                            ?: (option["value"] as? JsonPrimitive)?.contentOrNullIfNotString()
                        else -> null
                    }
                    label?.let {
                        Text(
                            text = "◦ $it",
                            style = MaterialTheme.typography.bodySmall,
                            color = hint,
                            modifier = Modifier.padding(start = 8.dp, top = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

// ----------------------------------------------------------------- result --

/** How a tool result renders: parsed diff > extracted text > pretty JSON. */
private sealed interface ResultRendering {
    data class Diffs(val files: List<DiffFile>) : ResultRendering
    data class Terminal(val text: String) : ResultRendering
    data class Json(val pretty: String) : ResultRendering
}

@Composable
private fun ToolResultSection(tool: ChatToolCall) {
    val result = tool.result ?: return
    if (result is JsonNull) return
    val isError = tool.state == "error"
    val rendering = remember(result) { resultRendering(result) } ?: return

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel(
            stringResource(if (isError) R.string.chat_result_error else R.string.chat_result),
        )
        when (rendering) {
            is ResultRendering.Diffs -> rendering.files.forEach { DiffView(file = it) }
            is ResultRendering.Terminal -> TerminalText(rendering.text, isError = isError)
            is ResultRendering.Json -> CodeBlock(code = rendering.pretty, language = "json")
        }
    }
}

private const val RESULT_RENDER_CAP = 20_000

private fun resultRendering(result: JsonElement): ResultRendering? {
    val text = extractResultText(result)
    if (text != null) {
        if (text.isBlank()) return null
        tryParseDiff(text)?.let { return ResultRendering.Diffs(it) }
        return ResultRendering.Terminal(text.take(RESULT_RENDER_CAP))
    }
    return ResultRendering.Json(prettyJson(result).take(RESULT_RENDER_CAP))
}

/**
 * Text of the common result shapes: plain string; `{stdout, stderr}`;
 * Claude-style `[{type: "text", text}]` arrays (or the same under `content`).
 * Null → not text-like, render as JSON.
 */
internal fun extractResultText(result: JsonElement): String? {
    when (result) {
        is JsonPrimitive -> return if (result.isString) result.content else null
        is JsonArray -> {
            val texts = result.map { entry ->
                val obj = entry as? JsonObject ?: return null
                if ((obj["type"] as? JsonPrimitive)?.content != "text") return null
                (obj["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            }
            return texts.joinToString("\n")
        }
        is JsonObject -> {
            val stdout = (result["stdout"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val stderr = (result["stderr"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (stdout != null || stderr != null) {
                val parts = mutableListOf<String>()
                stdout?.trimEnd()?.takeIf { it.isNotEmpty() }?.let(parts::add)
                stderr?.trimEnd()?.takeIf { it.isNotEmpty() }?.let { parts.add("stderr:\n$it") }
                return parts.joinToString("\n\n")
            }
            (result["content"] as? JsonArray)?.let { return extractResultText(it) }
            (result["content"] as? JsonPrimitive)?.takeIf { it.isString }?.let { return it.content }
            return null
        }
    }
}

// ---------------------------------------------------------------- helpers --

private val TERMINAL_TOOLS = setOf("Bash", "CodexBash", "shell_command", "run_shell_command")

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
    "xml" to "xml", "html" to "html", "css" to "css", "md" to "markdown", "sql" to "sql",
)

private fun languageForPath(path: String?): String? =
    path?.substringAfterLast('.', missingDelimiterValue = "")?.lowercase()
        ?.takeIf { it.isNotEmpty() }
        ?.let { EXTENSION_LANGUAGES[it] }

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

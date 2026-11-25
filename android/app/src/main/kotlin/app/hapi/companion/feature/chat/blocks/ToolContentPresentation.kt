package app.hapi.companion.feature.chat.blocks

import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.getInputStringAny
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Presentation aliases only; never rewrite the recorded call or grouping input. */
internal fun toolPresentationName(name: String): String = when (val local = name.removePrefix("functions.")) {
    "exec_command" -> "Bash"
    "apply_patch" -> "CodexPatch"
    else -> local
}

internal val TERMINAL_TOOLS = setOf("Bash", "CodexBash", "shell_command", "run_shell_command", "write_stdin")

internal fun toolSourceInput(input: JsonElement?, keys: List<String>): String? =
    input.textValue() ?: getInputStringAny(input, keys)

private fun JsonElement?.textValue(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun isPlanProposalTool(name: String): Boolean = name == "ExitPlanMode" || name == "exit_plan_mode"

/** A proposal is input.plan Markdown, not update_plan's checklist or a result. */
internal fun planProposalMarkdown(tool: ChatToolCall): String? =
    if (isPlanProposalTool(tool.name)) (tool.input as? JsonObject)?.get("plan").textValue()?.takeIf { it.isNotBlank() }
    else null

internal fun planProposalShowsResult(tool: ChatToolCall): Boolean {
    if (tool.state == "error") return true
    val result = tool.result ?: return false
    if (result is JsonNull) return false
    return result.textValue()?.isNotBlank() ?: true
}

/** Mixed content stays JSON, rather than silently discarding images/resources. */
internal fun extractResultText(result: JsonElement, depth: Int = 0): String? {
    if (depth > 4) return null
    return when (result) {
        is JsonPrimitive -> result.textValue()
        is JsonArray -> {
            val texts = result.map { entry ->
                entry.textValue() ?: run {
                    val obj = entry as? JsonObject ?: return null
                    if (obj["type"] != null && obj["type"].textValue() != "text") return null
                    obj["text"].textValue() ?: return null
                }
            }
            texts.joinToString("\n")
        }
        is JsonObject -> {
            val stdout = result["stdout"].textValue()
            val stderr = result["stderr"].textValue()
            if (stdout != null || stderr != null) {
                val parts = mutableListOf<String>()
                stdout?.takeIf { it.isNotEmpty() }?.let(parts::add)
                stderr?.takeIf { it.isNotEmpty() }?.let { parts.add("stderr:\n$it") }
                if (parts.isNotEmpty()) return parts.joinToString("\n\n")
            }
            (result["file"] as? JsonObject)?.get("content").textValue()?.let { return it }
            var emptyText: String? = null
            for (key in listOf("content", "text", "output", "error", "message", "result", "data")) {
                val value = result[key] ?: continue
                if (value is JsonNull) continue
                val text = extractResultText(value, depth + 1)
                if (!text.isNullOrEmpty()) return text
                if (text != null) emptyText = ""
                if (key == "content" && value is JsonArray && text == null) return null
            }
            if (stdout != null || stderr != null) "" else emptyText
        }
    }
}

internal sealed interface ToolResultStyle {
    data object Terminal : ToolResultStyle
    data class Code(val language: String?) : ToolResultStyle
    data object Markdown : ToolResultStyle
}

internal fun toolResultStyle(tool: ChatToolCall): ToolResultStyle {
    val name = toolPresentationName(tool.name)
    if (tool.state == "error") return ToolResultStyle.Terminal
    val parsed = ((tool.input as? JsonObject)?.get("parsed_cmd") as? JsonArray)?.singleOrNull()
    val readCommand = name == "CodexBash" && getInputStringAny(parsed, listOf("type")) == "read"
    if (name in setOf("Read", "NotebookRead") || readCommand) {
        val file = (tool.result as? JsonObject)?.get("file")
        val path = getInputStringAny(file, listOf("filePath", "file_path"))
            ?: getInputStringAny(tool.input, listOf("file_path", "path", "file", "notebook_path"))
            ?: if (readCommand) getInputStringAny(parsed, listOf("name", "path", "file_path")) else null
        return ToolResultStyle.Code(languageForPath(path))
    }
    if (name in setOf("WebFetch", "WebSearch", "Task", "Agent", "Skill", "ExitPlanMode", "exit_plan_mode")) {
        return ToolResultStyle.Markdown
    }
    return ToolResultStyle.Terminal
}

internal const val TOOL_TEXT_PAGE_SIZE = 20_000

/** No truncation; page boundaries never split UTF-16 surrogate pairs. */
internal fun toolTextPages(text: String): List<String> = buildList {
    var start = 0
    while (start < text.length) {
        var end = minOf(start + TOOL_TEXT_PAGE_SIZE, text.length)
        if (end < text.length && Character.isHighSurrogate(text[end - 1]) && Character.isLowSurrogate(text[end])) end--
        add(text.substring(start, end))
        start = end
    }
}

internal fun toolQuestionOptionText(option: JsonElement): String {
    option.textValue()?.let { return it }
    val label = getInputStringAny(option, listOf("label", "value")) ?: return prettyJson(option)
    val description = getInputStringAny(option, listOf("description"))
    return if (description.isNullOrEmpty()) label else "$label — $description"
}

/** Exit/status information remains visible even when stdout is empty. */
internal fun toolResultMetadata(result: JsonElement?, depth: Int = 0): List<String> {
    if (depth > 4) return emptyList()
    val obj = result as? JsonObject ?: return emptyList()
    val fields = listOf("exit_code" to listOf("exit_code", "exitCode"), "status" to listOf("status"),
        "session_id" to listOf("session_id"), "wall_time_seconds" to listOf("wall_time_seconds"))
    val metadata = fields.mapNotNull { (label, keys) ->
        val value = keys.firstNotNullOfOrNull { key ->
            (obj[key] as? JsonPrimitive)?.takeIf { it !is JsonNull &&
                (it.isString && it.content.isNotEmpty() || !it.isString && it.content.toDoubleOrNull() != null) }
        }
        value?.let { "$label: ${it.content}" }
    }
    if (metadata.isNotEmpty()) return metadata
    for (key in listOf("output", "result", "data")) {
        val nested = toolResultMetadata(obj[key], depth + 1)
        if (nested.isNotEmpty()) return nested
    }
    return emptyList()
}

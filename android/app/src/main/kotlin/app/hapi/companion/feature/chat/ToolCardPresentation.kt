package app.hapi.companion.feature.chat

import android.content.res.Resources
import app.hapi.companion.R
import app.hapi.protocol.chat.ChatToolCall
import app.hapi.protocol.chat.getInputStringAny
import app.hapi.protocol.chat.isAskUserQuestionToolName
import app.hapi.protocol.chat.isRequestUserInputToolName
import app.hapi.protocol.chat.truncate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Collapsed tool-card header: icon glyph + title + optional subtitle. Port of
 * the presentation registry in `web/src/components/ToolCard/knownTools.tsx`
 * (the read-only subset — the web's `minimal` flag maps to "no inline body by
 * default" and is a per-card expansion default here). Icons are text glyphs in
 * the same family as the event-row emoji the shared protocol presentation
 * already emits.
 */
data class ToolCardPresentation(
    val icon: String,
    val title: String,
    val subtitle: String?,
)

private object ToolIcons {
    const val TERMINAL = "💻"
    const val READ = "📖"
    const val SEARCH = "🔍"
    const val EDIT = "✏️"
    const val WEB = "🌐"
    const val AGENT = "🚀"
    const val QUESTION = "❓"
    const val PLAN = "📋"
    const val IDEA = "💡"
    const val PUZZLE = "🧩"
    const val MESSAGE = "💬"
    const val TEAM = "👥"
    const val WARNING = "⚠️"
    const val WRENCH = "🔧"
}

// ---------------------------------------------------------------- helpers --

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun countLines(text: String): Int = text.split('\n').size

/** Strip the session root so paths read workspace-relative (web `resolveDisplayPath`). */
internal fun displayPath(path: String, basePath: String?): String {
    if (basePath.isNullOrEmpty()) return path
    val root = basePath.trimEnd('/')
    return when {
        path == root -> "."
        path.startsWith("$root/") -> path.removePrefix("$root/")
        else -> path
    }
}

private fun basename(path: String): String =
    path.trimEnd('/').substringAfterLast('/')

// ------------------------------------------------------- terminal parsing --

private val COMMANDS_WITH_SUBCOMMAND =
    setOf("git", "bun", "npm", "pnpm", "yarn", "docker", "systemctl", "cargo", "go")
private val COMMAND_ASSIGNMENT_RE = Regex("^[A-Za-z_][A-Za-z0-9_]*=")
private val AMBIGUOUS_SHELL_RE = Regex("[;&|<>$`(){}\n\r]")

/** `formatTerminalCommandTitle` (web): the leading executable(+subcommand) of a simple command. */
internal fun formatTerminalCommandTitle(command: String?): String? {
    if (command.isNullOrEmpty() || AMBIGUOUS_SHELL_RE.containsMatchIn(command)) return null

    val parts = command.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    var index = 0
    while (COMMAND_ASSIGNMENT_RE.containsMatchIn(parts.getOrNull(index) ?: "")) index += 1

    if (parts.getOrNull(index) == "env") {
        index += 1
        while (
            parts.getOrNull(index) == "-i" ||
            parts.getOrNull(index) == "--ignore-environment" ||
            COMMAND_ASSIGNMENT_RE.containsMatchIn(parts.getOrNull(index) ?: "")
        ) index += 1
    }
    if (parts.getOrNull(index) == "sudo") {
        index += 1
        while (parts.getOrNull(index) in setOf("-n", "--non-interactive", "-E", "--preserve-env")) index += 1
    }
    if (parts.getOrNull(index)?.startsWith("-") == true) return null

    val executable = parts.getOrNull(index)?.let(::basename) ?: return null
    if (executable.isEmpty()) return null

    val subcommand = parts.getOrNull(index + 1)?.takeUnless { it.startsWith("-") }
    if (subcommand == null || executable !in COMMANDS_WITH_SUBCOMMAND) return executable
    if (executable in setOf("bun", "npm", "pnpm", "yarn") && subcommand == "run") {
        val script = parts.getOrNull(index + 2)
        return if (script != null && !script.startsWith("-")) "$executable run $script" else "$executable run"
    }
    if (executable == "docker" && subcommand == "compose") {
        val action = parts.getOrNull(index + 2)
        return if (action != null && !action.startsWith("-")) "docker compose $action" else "docker compose"
    }
    return "$executable $subcommand"
}

/** The command string, joining Codex-style `command: string[]` arrays. */
internal fun terminalCommand(input: JsonElement?): String? {
    getInputStringAny(input, listOf("command", "cmd"))?.let { return it }
    val array = input.asObjectOrNull()?.get("command") as? JsonArray ?: return null
    val parts = array.mapNotNull { it.asStringOrNull()?.takeIf(String::isNotEmpty) }
    return if (parts.isEmpty()) null else parts.joinToString(" ")
}

private fun terminalTitle(input: JsonElement?, description: String?, res: Resources): String {
    val command = terminalCommand(input)
    if (description != null && description != command) return description
    return formatTerminalCommandTitle(command) ?: description ?: res.getString(R.string.tool_terminal)
}

private fun terminalSubtitle(input: JsonElement?, description: String?, res: Resources): String? {
    val command = terminalCommand(input)
    return if (command == terminalTitle(input, description, res)) null else command
}

// ------------------------------------------------------------- questions --

private fun questionTitle(input: JsonElement?, res: Resources): String {
    val questions = input.asObjectOrNull()?.get("questions") as? JsonArray ?: JsonArray(emptyList())
    if (questions.size > 1) return res.getString(R.string.tool_questions, questions.size)
    val header = questions.firstOrNull().asObjectOrNull()?.get("header").asStringOrNull()?.trim().orEmpty()
    return header.ifEmpty { res.getString(R.string.tool_question) }
}

private fun questionSubtitle(input: JsonElement?, res: Resources): String? {
    val questions = input.asObjectOrNull()?.get("questions") as? JsonArray ?: JsonArray(emptyList())
    val question = questions.firstOrNull().asObjectOrNull()?.get("question").asStringOrNull()?.trim().orEmpty()
    if (questions.size > 1 && question.isNotEmpty()) {
        return res.getString(R.string.tool_questions_more, truncate(question, 100), questions.size - 1)
    }
    return question.takeIf { it.isNotEmpty() }?.let { truncate(it, 120) }
}

// --------------------------------------------------------------- MCP names --

private fun snakeToTitle(value: String): String = value
    .split('_')
    .filter { it.isNotEmpty() }
    .joinToString(" ") { part -> part.lowercase().replaceFirstChar { it.uppercaseChar() } }

private fun mcpTitle(toolName: String): String {
    val withoutPrefix = toolName.removePrefix("mcp__")
    val parts = withoutPrefix.split("__")
    return if (parts.size >= 2) {
        "MCP: ${snakeToTitle(parts[0])} ${snakeToTitle(parts.drop(1).joinToString("_"))}"
    } else {
        "MCP: ${snakeToTitle(withoutPrefix)}"
    }
}

// ------------------------------------------------------------ entry point --

@Suppress("CyclomaticComplexMethod", "LongMethod")
fun toolCardPresentation(
    tool: ChatToolCall,
    basePath: String?,
    /** Localizes the semantic fallback titles (B-M5a). */
    res: Resources,
): ToolCardPresentation {
    val input = tool.input
    val name = tool.name
    val description = tool.description

    if (name.startsWith("mcp__")) {
        return ToolCardPresentation(ToolIcons.PUZZLE, mcpTitle(name), null)
    }
    if (isAskUserQuestionToolName(name) || isRequestUserInputToolName(name)) {
        return ToolCardPresentation(ToolIcons.QUESTION, questionTitle(input, res), questionSubtitle(input, res))
    }

    fun filePathTitle(keys: List<String>, fallback: String): String =
        getInputStringAny(input, keys)?.let { displayPath(it, basePath) } ?: fallback

    when (name) {
        "Bash", "CodexBash", "shell_command", "run_shell_command" -> {
            // CodexBash single parsed read renders as the file it reads.
            if (name == "CodexBash") {
                val parsed = input.asObjectOrNull()?.get("parsed_cmd") as? JsonArray
                val first = parsed?.singleOrNull().asObjectOrNull()
                if (first?.get("type").asStringOrNull() == "read") {
                    first?.get("name").asStringOrNull()?.let { file ->
                        return ToolCardPresentation(
                            ToolIcons.READ,
                            displayPath(file, basePath),
                            terminalSubtitle(input, description, res),
                        )
                    }
                }
            }
            return ToolCardPresentation(
                ToolIcons.TERMINAL,
                terminalTitle(input, description, res),
                terminalSubtitle(input, description, res),
            )
        }

        "Read" -> return ToolCardPresentation(
            ToolIcons.READ, filePathTitle(listOf("file_path", "path", "file"), res.getString(R.string.tool_read_file)), null,
        )

        "NotebookRead" -> return ToolCardPresentation(
            ToolIcons.READ, filePathTitle(listOf("notebook_path"), res.getString(R.string.tool_read_notebook)), null,
        )

        "Edit" -> return ToolCardPresentation(
            ToolIcons.EDIT, filePathTitle(listOf("file_path", "path"), res.getString(R.string.tool_edit_file)), null,
        )

        "MultiEdit" -> {
            val file = getInputStringAny(input, listOf("file_path", "path"))
                ?: return ToolCardPresentation(ToolIcons.EDIT, res.getString(R.string.tool_edit_file), null)
            val count = (input.asObjectOrNull()?.get("edits") as? JsonArray)?.size ?: 0
            val path = displayPath(file, basePath)
            return ToolCardPresentation(
                ToolIcons.EDIT,
                if (count > 1) res.getString(R.string.tool_edits_count, path, count) else path,
                null,
            )
        }

        "Write" -> {
            val content = getInputStringAny(input, listOf("content", "text"))
            val subtitle = content?.let {
                val lines = countLines(it)
                if (lines > 1) {
                    res.getString(R.string.tool_write_lines, lines)
                } else {
                    res.getString(R.string.tool_write_chars, it.length)
                }
            }
            return ToolCardPresentation(
                ToolIcons.EDIT, filePathTitle(listOf("file_path", "path"), res.getString(R.string.tool_write_file)), subtitle,
            )
        }

        "NotebookEdit" -> return ToolCardPresentation(
            ToolIcons.EDIT,
            filePathTitle(listOf("notebook_path"), res.getString(R.string.tool_edit_notebook)),
            getInputStringAny(input, listOf("edit_mode"))?.let { "mode: $it" },
        )

        "Glob" -> return ToolCardPresentation(
            ToolIcons.SEARCH, getInputStringAny(input, listOf("pattern")) ?: res.getString(R.string.tool_search_files), null,
        )

        "Grep" -> {
            val pattern = getInputStringAny(input, listOf("pattern"))
            return ToolCardPresentation(
                ToolIcons.SEARCH, pattern?.let { "grep(pattern: $it)" } ?: res.getString(R.string.tool_search_content), null,
            )
        }

        "LS" -> return ToolCardPresentation(
            ToolIcons.SEARCH, filePathTitle(listOf("path"), res.getString(R.string.tool_list_files)), null,
        )

        "WebFetch" -> {
            val url = getInputStringAny(input, listOf("url"))
                ?: return ToolCardPresentation(ToolIcons.WEB, res.getString(R.string.tool_web_fetch), null)
            val host = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://([^/]+)").find(url)?.groupValues?.get(1) ?: url
            return ToolCardPresentation(ToolIcons.WEB, host, url)
        }

        "WebSearch" -> {
            val query = getInputStringAny(input, listOf("query"))
            return ToolCardPresentation(ToolIcons.WEB, query ?: res.getString(R.string.tool_web_search), query?.let { truncate(it, 80) })
        }

        "Task", "Agent" -> {
            val inputName = getInputStringAny(input, listOf("name"))
            val teamName = getInputStringAny(input, listOf("team_name"))
            val title = when {
                name == "Task" && inputName != null && teamName != null ->
                    res.getString(R.string.tool_agent_named, inputName)
                else -> getInputStringAny(input, listOf("description"))
                    ?: res.getString(if (name == "Task") R.string.tool_task else R.string.tool_launch_agent)
            }
            val subtitle = getInputStringAny(input, listOf("prompt"))?.let { truncate(it, 120) }
                ?: getInputStringAny(input, listOf("subagent_type"))
            return ToolCardPresentation(ToolIcons.AGENT, title, subtitle)
        }

        "CodexAgent", "spawn_agent", "resume_agent", "wait_agent", "close_agent", "interrupt_agent" -> {
            val title = res.getString(
                when (name) {
                    "spawn_agent" -> R.string.tool_spawn_agent
                    "resume_agent" -> R.string.tool_resume_agent
                    "wait_agent" -> R.string.tool_wait_agent
                    "close_agent" -> R.string.tool_close_agent
                    "interrupt_agent" -> R.string.tool_interrupt_agent
                    else -> R.string.tool_agent
                },
            )
            val prompt = getInputStringAny(input, listOf("prompt", "summary"))
            return ToolCardPresentation(ToolIcons.AGENT, title, prompt?.let { truncate(it, 120) })
        }

        "SendMessage", "send_input", "send_message", "followup_task" -> {
            val recipient = getInputStringAny(input, listOf("recipient"))
            val msgType = getInputStringAny(input, listOf("type"))
            val title = when {
                msgType == "broadcast" -> res.getString(R.string.tool_broadcast)
                msgType == "shutdown_request" -> res.getString(
                    R.string.tool_shutdown,
                    recipient ?: res.getString(R.string.tool_shutdown_fallback_recipient),
                )
                msgType == "shutdown_response" -> res.getString(R.string.tool_shutdown_response)
                recipient != null -> res.getString(R.string.tool_message_named, recipient)
                else -> res.getString(R.string.tool_message_agent)
            }
            val summary = getInputStringAny(input, listOf("summary"))
            return ToolCardPresentation(ToolIcons.MESSAGE, title, summary?.let { truncate(it, 120) })
        }

        "list_agents" -> return ToolCardPresentation(ToolIcons.TEAM, res.getString(R.string.tool_list_agents), null)

        "TeamCreate" -> {
            val teamName = getInputStringAny(input, listOf("team_name"))
            return ToolCardPresentation(
                ToolIcons.TEAM,
                teamName?.let { res.getString(R.string.tool_team_named, it) }
                    ?: res.getString(R.string.tool_create_team),
                getInputStringAny(input, listOf("description")),
            )
        }

        "TeamDelete" -> return ToolCardPresentation(ToolIcons.TEAM, res.getString(R.string.tool_delete_team), null)

        "TodoWrite" -> return ToolCardPresentation(ToolIcons.IDEA, res.getString(R.string.tool_todo_list), null)

        "update_plan" -> return ToolCardPresentation(ToolIcons.PLAN, res.getString(R.string.tool_plan), null)

        "ExitPlanMode", "exit_plan_mode" -> return ToolCardPresentation(ToolIcons.PLAN, res.getString(R.string.tool_plan_proposal), null)

        "Skill" -> {
            val skill = getInputStringAny(input, listOf("skill"))
            return ToolCardPresentation(
                ToolIcons.PUZZLE,
                skill?.let { res.getString(R.string.tool_skill_named, it) } ?: res.getString(R.string.tool_skill),
                null,
            )
        }

        "CodexReasoning" -> return ToolCardPresentation(
            ToolIcons.IDEA, getInputStringAny(input, listOf("title")) ?: res.getString(R.string.tool_reasoning), null,
        )

        "CodexPermission" -> {
            val permissionTool = getInputStringAny(input, listOf("tool"))
            return ToolCardPresentation(
                ToolIcons.QUESTION,
                permissionTool?.let { res.getString(R.string.tool_permission_named, it) }
                    ?: res.getString(R.string.tool_permission_request),
                getInputStringAny(input, listOf("message", "command")),
            )
        }

        "CodexPatch" -> {
            val changes = input.asObjectOrNull()?.get("changes").asObjectOrNull()
            val files = changes?.keys?.toList().orEmpty()
            val subtitle = files.firstOrNull()?.let { first ->
                val display = basename(displayPath(first, basePath))
                if (files.size > 1) "$display (+${files.size - 1})" else display
            }
            return ToolCardPresentation(ToolIcons.EDIT, res.getString(R.string.tool_apply_changes), subtitle)
        }

        "CodexDiff" -> {
            val unified = getInputStringAny(input, listOf("unified_diff"))
            val subtitle = unified?.lineSequence()
                ?.firstOrNull { it.startsWith("+++ ") }
                ?.removePrefix("+++ ")?.removePrefix("b/")
                ?.let { it.substringAfterLast('/') }
            return ToolCardPresentation(ToolIcons.EDIT, res.getString(R.string.tool_diff), subtitle)
        }

        "AgyTaskLog" -> {
            val task = getInputStringAny(input, listOf("task"))
            return ToolCardPresentation(
                ToolIcons.MESSAGE,
                task?.let { res.getString(R.string.tool_task_log, it) }
                    ?: res.getString(R.string.tool_inspecting_task_log),
                null,
            )
        }

        "AgyAsyncTask" -> return ToolCardPresentation(ToolIcons.PLAN, description ?: res.getString(R.string.tool_background_task), null)

        "AgyError" -> return ToolCardPresentation(ToolIcons.WARNING, description ?: res.getString(R.string.tool_error), null)
    }

    // Generic fallback (web `getToolPresentation` tail): promote a semantic
    // label when an ACP agent's title is the verbatim argument.
    val filePath = getInputStringAny(input, listOf("file_path", "path", "filePath", "file"))
    val command = getInputStringAny(input, listOf("command", "cmd"))
    val pattern = getInputStringAny(input, listOf("pattern"))
    val url = getInputStringAny(input, listOf("url"))
    val query = getInputStringAny(input, listOf("query"))
    val nameInput = getInputStringAny(input, listOf("name"))
    val subtitle = filePath ?: command ?: pattern ?: url ?: query ?: nameInput

    var title = description ?: name
    if (subtitle != null && subtitle == title) {
        title = when {
            filePath != null -> res.getString(R.string.tool_read_file)
            command != null -> res.getString(R.string.tool_run_shell)
            pattern != null -> res.getString(R.string.tool_search)
            url != null -> res.getString(R.string.tool_open_url)
            query != null -> res.getString(R.string.tool_query)
            else -> title
        }
    }
    return ToolCardPresentation(
        ToolIcons.WRENCH,
        title,
        subtitle?.takeIf { it != title }?.let { truncate(it, 80) },
    )
}

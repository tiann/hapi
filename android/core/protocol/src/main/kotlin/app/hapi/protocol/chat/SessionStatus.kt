package app.hapi.protocol.chat

import app.hapi.protocol.wire.TodoItem
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Derived "what is happening right now" snapshot of a session: the thread
 * goal, the todo list, in-flight subagents and background terminals. Built
 * from the reduced block tree plus the session record; rendering consumes it
 * read-only. All timestamps are epoch milliseconds received from the hub
 * (execution-machine clocks are never used here).
 */

/** Subagent lifecycle states shown in the panel. */
object SessionSubagentState {
    const val RUNNING = "running"
    const val WAITING = "waiting"
    const val ERROR = "error"
}

/** Thread goal statuses produced by the goal tracker. */
object ThreadGoalStatus {
    const val ACTIVE = "active"
    const val PAUSED = "paused"
    const val BUDGET_LIMITED = "budgetLimited"
    const val USAGE_LIMITED = "usageLimited"
    const val BLOCKED = "blocked"
    const val COMPLETE = "complete"
}

/**
 * A thread goal as normalized by the event pipeline: `threadId`, `objective`
 * and a valid `status` are mandatory, numeric counters default to 0.
 */
data class ThreadGoal(
    val threadId: String,
    val objective: String,
    val status: String,
    val tokenBudget: Double? = null,
    val tokensUsed: Double = 0.0,
    val timeUsedSeconds: Double = 0.0,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
) {
    companion object {
        /** Lenient read over the normalized goal object; null when unusable. */
        fun from(raw: JsonObject?): ThreadGoal? {
            if (raw == null) return null
            val threadId = asString(raw["threadId"]) ?: return null
            val objective = asString(raw["objective"]) ?: return null
            val status = asString(raw["status"]) ?: return null
            return ThreadGoal(
                threadId = threadId,
                objective = objective,
                status = status,
                tokenBudget = asNumber(raw["tokenBudget"].orNull()),
                tokensUsed = asNumber(raw["tokensUsed"].orNull()) ?: 0.0,
                timeUsedSeconds = asNumber(raw["timeUsedSeconds"].orNull()) ?: 0.0,
                createdAt = asNumber(raw["createdAt"].orNull()) ?: 0.0,
                updatedAt = asNumber(raw["updatedAt"].orNull()) ?: 0.0,
            )
        }
    }
}

/** A background shell task still believed to be running. */
data class SessionStatusSubagent(
    val id: String,
    val title: String,
    val detail: String? = null,
    /** One of [SessionSubagentState]. */
    val state: String,
    /** Null while the call is queued and has not started executing yet. */
    val startedAt: Long? = null,
    /** Only set for failed calls; freezes the elapsed display at that instant. */
    val endedAt: Long? = null,
)

/** A background terminal detected from a Bash tool result. */
data class SessionStatusTerminal(
    /** Background task id (for example `"bg-1"`). */
    val id: String,
    val command: String,
    val cwd: String? = null,
    val startedAt: Long,
)

data class SessionStatusData(
    val goal: ThreadGoal? = null,
    val tasks: List<TodoItem> = emptyList(),
    val subagents: List<SessionStatusSubagent> = emptyList(),
    val terminals: List<SessionStatusTerminal> = emptyList(),
    val undiscoveredTerminalCount: Int = 0,
    val possibleTerminalCommands: List<String> = emptyList(),
) {
    /**
     * Whether any elapsed timer is still advancing: a live terminal, or a
     * subagent that has started but not ended. When false the caller should
     * not keep a clock ticking for this snapshot.
     */
    val hasLiveElapsed: Boolean
        get() = terminals.isNotEmpty() ||
            subagents.any { it.endedAt == null && it.startedAt != null }
}

private val BACKGROUND_START_RE = Regex("Command running in background with ID:\\s*([^\\s<]+)")
private val TASK_ID_RE = Regex("<task-id>\\s*([^<]+?)\\s*</task-id>")

/** First background-task id mentioned anywhere inside [value], depth-first. */
private fun findBackgroundTaskId(value: JsonElement?): String? {
    if (value is JsonPrimitive && value.isString) {
        return BACKGROUND_START_RE.find(value.content)?.groupValues?.get(1)
    }
    val values: List<JsonElement> = when (value) {
        is JsonArray -> value
        is JsonObject -> value.values.toList()
        else -> return null
    }
    for (item in values) {
        val taskId = findBackgroundTaskId(item)
        if (taskId != null) return taskId
    }
    return null
}

/** Command line of a Bash input object: `command`/`cmd` string, or a string array joined by spaces. */
private fun commandFromInput(input: JsonElement?): String? {
    val command = getInputStringAny(input, listOf("command", "cmd"))
    if (command != null) return command
    val obj = asObject(input) ?: return null
    val commandArray = obj["command"] as? JsonArray ?: return null
    val parts = commandArray.mapNotNull { item ->
        (item as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
    return if (parts.isNotEmpty()) parts.joinToString(" ") else null
}

private fun terminalFromBlock(block: ToolCallBlock): SessionStatusTerminal? {
    if (block.tool.name != "Bash") return null
    val taskId = findBackgroundTaskId(block.tool.result) ?: return null
    return SessionStatusTerminal(
        id = taskId,
        command = commandFromInput(block.tool.input) ?: block.tool.description ?: block.tool.name,
        cwd = getInputStringAny(block.tool.input, listOf("cwd", "workdir", "path")),
        startedAt = block.tool.startedAt?.toLong() ?: block.createdAt,
    )
}

/** All tool-call blocks in the tree, parents before their children. */
private fun collectToolBlocks(blocks: List<ChatBlock>): List<ToolCallBlock> {
    val tools = mutableListOf<ToolCallBlock>()
    for (block in blocks) {
        if (block !is ToolCallBlock) continue
        tools.add(block)
        tools.addAll(collectToolBlocks(block.children))
    }
    return tools
}

private data class BackgroundTaskCompletions(
    val ids: Set<String>,
    /** Latest anonymous completion notice; terminals started at or before it may have ended. */
    val latestUnknownAt: Long?,
)

/**
 * Task-completion notices arrive as agent sidechain prompts wrapped in
 * `<task-notification>` elements. Notices naming a `<task-id>` complete that
 * task; anonymous ones only record their arrival time.
 */
private fun backgroundTaskCompletions(messages: List<NormalizedMessage>): BackgroundTaskCompletions {
    val ids = mutableSetOf<String>()
    var latestUnknownAt: Long? = null

    for (message in messages) {
        if (message !is NormalizedMessage.Agent) continue
        for (content in message.content) {
            if (content !is NormalizedAgentContent.Sidechain) continue
            val prompt = content.prompt.trimStart()
            if (!prompt.startsWith("<task-notification>")) continue
            val taskId = TASK_ID_RE.find(prompt)?.groupValues?.get(1)?.trim()
            if (!taskId.isNullOrEmpty()) {
                ids.add(taskId)
            } else {
                latestUnknownAt = maxOf(latestUnknownAt ?: 0L, message.createdAt)
            }
        }
    }

    return BackgroundTaskCompletions(ids, latestUnknownAt)
}

/**
 * Split detected terminals into `confirmed` (known to be running) and
 * `uncertain` (may have been ended by an anonymous completion notice).
 */
private fun buildBackgroundTerminals(
    tools: List<ToolCallBlock>,
    messages: List<NormalizedMessage>,
): Pair<List<SessionStatusTerminal>, List<SessionStatusTerminal>> {
    val terminals = tools.mapNotNull(::terminalFromBlock)
    val completions = backgroundTaskCompletions(messages)
    val remaining = terminals.filter { it.id !in completions.ids }
    val latestUnknownAt = completions.latestUnknownAt ?: return remaining to emptyList()
    val confirmed = remaining.filter { it.startedAt > latestUnknownAt }
    val uncertain = remaining.filter { it.startedAt <= latestUnknownAt }
    return confirmed to uncertain
}

private fun collapseWhitespace(text: String): String =
    text.replace(Regex("\\s+"), " ").trim()

// --- Subagent call summaries (spawn-agent flavor) ---------------------------

private val LEADING_BULLET_RE = Regex("^[-*]\\s+")
private val LEADING_HEADING_RE = Regex("^#{1,6}\\s+")
private val LEADING_TASK_PREFIX_RE = Regex("^(task|your task|request|prompt)\\s*[:：]\\s*", RegexOption.IGNORE_CASE)
private val HTML_TAG_RE = Regex("<[^>\\n]+>")

/** Boilerplate lines that carry no summary value for an agent prompt. */
private val NOISE_LINE_PATTERNS = listOf(
    Regex("not alone in the codebase", RegexOption.IGNORE_CASE),
    Regex("do not revert", RegexOption.IGNORE_CASE),
    Regex("don't revert", RegexOption.IGNORE_CASE),
    Regex("list the file paths", RegexOption.IGNORE_CASE),
    Regex("changed files", RegexOption.IGNORE_CASE),
    Regex("final answer", RegexOption.IGNORE_CASE),
    Regex("avoid merge conflicts", RegexOption.IGNORE_CASE),
    Regex("accommodate the changes", RegexOption.IGNORE_CASE),
)

private fun cleanAgentPromptForSummary(prompt: String): String {
    val withoutTags = prompt.replace(HTML_TAG_RE, " ").replace("\r", "\n")
    val lines = withoutTags.split("\n")
        .map { line -> line.trim().replace(LEADING_BULLET_RE, "").replace(LEADING_HEADING_RE, "") }
        .filter { it.isNotEmpty() }
        .filter { line -> NOISE_LINE_PATTERNS.none { it.containsMatchIn(line) } }
    val candidate = if (lines.isNotEmpty()) lines.joinToString(" ") else withoutTags
    return collapseWhitespace(candidate).replace(LEADING_TASK_PREFIX_RE, "").trim()
}

private fun codexAgentPrompt(input: JsonElement?): String? {
    val direct = getInputStringAny(input, listOf("message", "prompt"))
    if (direct != null) return direct
    val items = asObject(input)?.get("items") as? JsonArray ?: return null
    val textParts = items.mapNotNull { item ->
        asObject(item)?.let { asString(it["text"]) }?.trim()?.takeIf { it.isNotEmpty() }
    }
    return if (textParts.isNotEmpty()) textParts.joinToString("\n\n") else null
}

fun summarizeAgentPrompt(prompt: String, maxLength: Int = 80): String? {
    val cleaned = cleanAgentPromptForSummary(prompt)
    if (cleaned.isEmpty()) return null
    return truncate(cleaned, maxLength)
}

private fun codexAgentType(input: JsonElement?): String? =
    getInputStringAny(input, listOf("agent_type", "subagent_type", "type"))

/** Short human label for a spawn-agent call: explicit summary, else cleaned prompt, else type. */
fun codexAgentSummary(input: JsonElement?): String? {
    val explicit = getInputStringAny(input, listOf("summary", "title", "description"))
    if (explicit != null) return truncate(collapseWhitespace(explicit), 80)

    codexAgentPrompt(input)?.let { prompt ->
        summarizeAgentPrompt(prompt)?.let { return it }
    }

    return codexAgentType(input)?.let { type -> "$type agent" }
}

private fun codexAgentStatus(input: JsonElement?): String? =
    getInputStringAny(input, listOf("agentStatus", "status", "state"))?.trim()?.lowercase(Locale.ROOT)

private fun isTerminalCodexAgentStatus(status: String?): Boolean =
    status == "completed" || status == "failed" || status == "error" ||
        status == "canceled" || status == "cancelled"

/** Non-terminal "completed" phrases describe a step, not the agent — reword them. */
private val NON_TERMINAL_ACTIVITY_REPLACEMENTS = listOf(
    Regex("^Command completed\\b", RegexOption.IGNORE_CASE) to "Command finished",
    Regex("^Tool completed\\b", RegexOption.IGNORE_CASE) to "Tool finished",
    Regex("^Completed\\s*:\\s*", RegexOption.IGNORE_CASE) to "Output ready: ",
    Regex("^Completed$", RegexOption.IGNORE_CASE) to "Running",
)

private fun normalizeNonTerminalAgentActivity(activity: String): String {
    for ((pattern, replacement) in NON_TERMINAL_ACTIVITY_REPLACEMENTS) {
        if (pattern.containsMatchIn(activity)) {
            return pattern.replaceFirst(activity, replacement)
        }
    }
    return activity
}

/** Live progress line of a spawn-agent call, with non-terminal wording fixed up. */
fun codexAgentActivity(input: JsonElement?): String? {
    val activity = getInputStringAny(input, listOf("activity", "statusText", "status_text", "agentStatus"))
    if (activity == null) return null
    val status = codexAgentStatus(input)
    return if (isTerminalCodexAgentStatus(status)) activity
    else normalizeNonTerminalAgentActivity(activity)
}

private fun subagentTitle(block: ToolCallBlock): String {
    if (block.tool.name == "CodexAgent") {
        return codexAgentSummary(block.tool.input) ?: "Agent"
    }
    getInputStringAny(block.tool.input, listOf("description", "summary", "title"))?.let { explicit ->
        return truncate(collapseWhitespace(explicit), 100)
    }
    getInputStringAny(block.tool.input, listOf("prompt", "message"))?.let { prompt ->
        return truncate(collapseWhitespace(prompt), 100)
    }
    return getInputStringAny(block.tool.input, listOf("subagent_type", "agent_type")) ?: "Agent"
}

private fun subagentFromBlock(block: ToolCallBlock): SessionStatusSubagent? {
    if (block.tool.name != "CodexAgent" && !isSubagentToolName(block.tool.name)) return null
    if (block.tool.state == ToolState.COMPLETED) return null

    val latestChild = block.children.lastOrNull()
    val activity = if (block.tool.name == "CodexAgent") {
        codexAgentActivity(block.tool.input)
    } else {
        (latestChild as? ToolCallBlock)?.tool?.let { it.nativeTitle ?: it.name }
    }
    val waiting = block.tool.state == ToolState.PENDING ||
        activity?.lowercase(Locale.ROOT)?.startsWith("waiting") == true

    return SessionStatusSubagent(
        id = block.tool.id,
        title = subagentTitle(block),
        detail = activity,
        state = when {
            block.tool.state == ToolState.ERROR -> SessionSubagentState.ERROR
            waiting -> SessionSubagentState.WAITING
            else -> SessionSubagentState.RUNNING
        },
        startedAt = block.tool.startedAt?.toLong()
            ?: if (block.tool.state == ToolState.PENDING) null else block.createdAt,
        endedAt = if (block.tool.state == ToolState.ERROR) {
            block.tool.completedAt?.toLong() ?: block.tool.startedAt?.toLong() ?: block.createdAt
        } else {
            null
        },
    )
}

/**
 * Build the session status snapshot. Returns null when the session has no
 * visible live state at all — goal, todos, subagents, terminals and unknown
 * terminal counts are all empty — so callers skip the panel entirely.
 *
 * [goal] is the raw normalized goal object (as produced by the reducer);
 * [backgroundTaskCount] is the hub's authoritative running-task count, and
 * `null` means "unknown, trust the detected terminals".
 */
fun buildSessionStatusData(
    goal: JsonObject?,
    tasks: List<TodoItem>?,
    blocks: List<ChatBlock>,
    messages: List<NormalizedMessage>,
    backgroundTaskCount: Int? = null,
): SessionStatusData? {
    val tools = collectToolBlocks(blocks)
    val detected = buildBackgroundTerminals(tools, messages)
    val detectedConfirmed = detected.first
    val detectedUncertain = detected.second

    val terminals: List<SessionStatusTerminal> = when {
        backgroundTaskCount == null -> detectedConfirmed + detectedUncertain
        backgroundTaskCount > 0 -> detectedConfirmed.takeLast(backgroundTaskCount)
        else -> emptyList()
    }
    val undiscoveredTerminalCount = if (backgroundTaskCount == null) {
        0
    } else {
        maxOf(0, backgroundTaskCount - terminals.size)
    }
    val possibleTerminalCommands = if (undiscoveredTerminalCount > 0) {
        detectedUncertain.map { it.command }
    } else {
        emptyList()
    }

    val data = SessionStatusData(
        goal = ThreadGoal.from(goal),
        tasks = tasks?.toList() ?: emptyList(),
        subagents = tools.mapNotNull(::subagentFromBlock),
        terminals = terminals,
        undiscoveredTerminalCount = undiscoveredTerminalCount,
        possibleTerminalCommands = possibleTerminalCommands,
    )

    return if (
        data.goal != null ||
        data.tasks.isNotEmpty() ||
        data.subagents.isNotEmpty() ||
        data.terminals.isNotEmpty() ||
        data.undiscoveredTerminalCount > 0
    ) {
        data
    } else {
        null
    }
}

/**
 * Compact duration: one decimal below a minute ("7.3s"), then whole
 * h/m/s segments with zero segments omitted ("1m 5s", "2h").
 */
fun formatCompactDuration(ms: Double): String {
    val seconds = ms / 1000
    if (seconds < 60) return String.format(Locale.ROOT, "%.1fs", seconds)

    val totalSeconds = Math.round(seconds)
    val hours = totalSeconds / 3_600
    val minutes = (totalSeconds % 3_600) / 60
    val remainingSeconds = totalSeconds % 60
    val parts = mutableListOf<String>()
    if (hours > 0) parts.add("${hours}h")
    if (minutes > 0) parts.add("${minutes}m")
    if (remainingSeconds > 0) parts.add("${remainingSeconds}s")
    return parts.joinToString(" ")
}

/**
 * Elapsed text for a live row: null when [startedAt] is unknown or invalid;
 * otherwise the distance from [startedAt] to [now] (never negative).
 */
fun elapsedSince(startedAt: Long?, now: Long): String? {
    if (startedAt == null || startedAt <= 0) return null
    return formatCompactDuration(maxOf(0L, now - startedAt).toDouble())
}

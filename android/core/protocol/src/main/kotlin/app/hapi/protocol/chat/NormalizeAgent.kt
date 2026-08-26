package app.hapi.protocol.chat

import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Port of `web/src/chat/normalizeAgent.ts` (1242 lines — kept in source order). */

/** `AGENT_MESSAGE_PAYLOAD_TYPE` (`shared/src/modes.ts`). */
const val AGENT_MESSAGE_PAYLOAD_TYPE = "codex"

private fun normalizeToolResultPermissions(value: JsonElement?): ToolResultPermission? {
    val record = asObject(value) ?: return null
    val date = asNumber(record["date"]) ?: return null
    val result = asString(record["result"])
    if (result != "approved" && result != "denied") return null

    val allowedTools = (record["allowedTools"] as? JsonArray)
        ?.mapNotNull { item -> (item as? JsonPrimitive)?.takeIf { it.isString }?.content }
    val decision = asString(record["decision"])
    val normalizedDecision = decision.takeIf {
        it == "approved" || it == "approved_for_session" || it == "denied" || it == "abort"
    }

    return ToolResultPermission(
        date = date,
        result = result,
        mode = asString(record["mode"]),
        allowedTools = allowedTools,
        decision = normalizedDecision,
    )
}

private fun normalizeAgentEvent(value: JsonElement?): AgentEvent? {
    val record = asObject(value) ?: return null
    if (asString(record["type"]) == null) return null
    return AgentEvent.of(record)
}

/** Builds the normalized `ThreadGoal` object exactly as the TS literal would stringify. */
private fun normalizeThreadGoal(value: JsonElement?): JsonObject? {
    val record = asObject(value) ?: return null
    val threadId = asString(record["threadId"].orNull() ?: record["thread_id"]) ?: return null
    val objective = asString(record["objective"]) ?: return null
    val status = asString(record["status"]) ?: return null
    if (
        status != "active" && status != "paused" && status != "budgetLimited"
        && status != "usageLimited" && status != "blocked" && status != "complete"
    ) return null
    val tokenBudget = asNumber(record["tokenBudget"].orNull() ?: record["token_budget"])
    return buildJsonObject {
        put("threadId", threadId)
        put("objective", objective)
        put("status", status)
        put("tokenBudget", tokenBudget?.let(::jsNumber) ?: JsonNull)
        put("tokensUsed", jsNumber(asNumber(record["tokensUsed"].orNull() ?: record["tokens_used"]) ?: 0.0))
        put("timeUsedSeconds", jsNumber(asNumber(record["timeUsedSeconds"].orNull() ?: record["time_used_seconds"]) ?: 0.0))
        put("createdAt", jsNumber(asNumber(record["createdAt"].orNull() ?: record["created_at"]) ?: 0.0))
        put("updatedAt", jsNumber(asNumber(record["updatedAt"].orNull() ?: record["updated_at"]) ?: 0.0))
    }
}

private fun normalizeCodexTokenUsage(value: JsonElement?, data: JsonObject?): UsageData? {
    val info = asObject(value) ?: return null
    val scope = data?.get("scope")?.let(::asObject)
    // Prefer `last` (current turn) over `total` (cumulative). See TS comments.
    val usageSource = asObject(info["last"])
        ?: asObject(info["lastTokenUsage"])
        ?: asObject(info["last_token_usage"])
        ?: asObject(info["total"])
        ?: asObject(info["totalTokenUsage"])
        ?: asObject(info["total_token_usage"])
        ?: info
    val inputTokens = asNumber(usageSource["inputTokens"].orNull() ?: usageSource["input_tokens"]) ?: return null
    val outputTokens = asNumber(usageSource["outputTokens"].orNull() ?: usageSource["output_tokens"]) ?: return null

    return UsageData(
        inputTokens = inputTokens,
        outputTokens = outputTokens,
        cacheCreationInputTokens = null,
        cacheReadInputTokens = asNumber(
            usageSource["cachedInputTokens"].orNull()
                ?: usageSource["cached_input_tokens"].orNull()
                ?: usageSource["cacheReadInputTokens"].orNull()
                ?: usageSource["cache_read_input_tokens"]
        ),
        contextTokens = asNumber(
            info["contextTokens"].orNull()
                ?: info["context_tokens"].orNull()
                ?: usageSource["contextTokens"].orNull()
                ?: usageSource["context_tokens"]
        ) ?: inputTokens,
        contextWindow = asNumber(info["modelContextWindow"].orNull() ?: info["model_context_window"]),
        threadId = asString(
            data?.get("thread_id").orNull()
                ?: data?.get("threadId").orNull()
                ?: scope?.get("thread_id").orNull()
                ?: scope?.get("threadId").orNull()
                ?: info["thread_id"].orNull()
                ?: info["threadId"]
        ),
        scopeRole = asString(data?.get("scope_role").orNull() ?: data?.get("scopeRole").orNull() ?: scope?.get("role")),
    )
}

private fun normalizePlanStatus(value: JsonElement?): String {
    val raw = asString(value)?.trim()?.lowercase()?.replace(Regex("[\\s-]"), "_") ?: ""
    if (raw == "completed" || raw == "complete" || raw == "done") return "completed"
    if (raw == "in_progress" || raw == "inprogress" || raw == "active" || raw == "running") return "in_progress"
    return "pending"
}

private fun normalizePlanEntries(value: JsonElement?): List<Pair<String, String>> {
    val record = asObject(value)
    val entries: List<JsonElement> = if (value is JsonArray) {
        value
    } else {
        record?.get("plan") as? JsonArray
            ?: record?.get("items") as? JsonArray
            ?: record?.get("steps") as? JsonArray
            ?: emptyList()
    }

    val plan = mutableListOf<Pair<String, String>>()
    for (entry in entries) {
        if (entry is JsonPrimitive && entry.isString) {
            plan.add(entry.content to "pending")
            continue
        }
        val entryRecord = asObject(entry) ?: continue
        val step = asString(entryRecord["step"])
            ?: asString(entryRecord["content"])
            ?: asString(entryRecord["text"])
            ?: asString(entryRecord["title"])
            ?: asString(entryRecord["description"])
            ?: continue
        plan.add(step to normalizePlanStatus(entryRecord["status"].orNull() ?: entryRecord["state"]))
    }
    return plan
}

/** `{ step, status }[]` as a JSON array (the exact shape the TS literal produces). */
private fun planToJson(plan: List<Pair<String, String>>): JsonArray = JsonArray(
    plan.map { (step, status) ->
        buildJsonObject {
            put("step", step)
            put("status", status)
        }
    }
)

private fun normalizeCodexReviewFinding(value: JsonElement?): CodexReviewFinding? {
    val record = asObject(value) ?: return null
    val title = asString(record["title"]) ?: return null
    val body = asString(record["body"]) ?: return null

    val codeLocation = asObject(record["code_location"]) ?: asObject(record["codeLocation"])
    val lineRange = codeLocation?.let { asObject(it["line_range"]) ?: asObject(it["lineRange"]) }

    return CodexReviewFinding(
        title = title,
        body = body,
        priority = asNumber(record["priority"]),
        confidenceScore = asNumber(record["confidence_score"].orNull() ?: record["confidenceScore"]),
        filePath = codeLocation?.let {
            asString(it["absolute_file_path"].orNull() ?: it["absoluteFilePath"].orNull() ?: it["path"])
        },
        lineStart = lineRange?.let { asNumber(it["start"]) },
        lineEnd = lineRange?.let { asNumber(it["end"]) },
    )
}

private fun normalizeCodexReviewJson(value: JsonElement?): CodexReview? {
    val record = asObject(value) ?: return null
    val hasReviewMarker = record["findings"] is JsonArray
        || record.containsKey("overall_correctness")
        || record.containsKey("overallCorrectness")
        || record.containsKey("overall_explanation")
        || record.containsKey("overallExplanation")
    if (!hasReviewMarker) return null

    val findings = (record["findings"] as? JsonArray)
        ?.mapNotNull(::normalizeCodexReviewFinding)
        ?: emptyList()

    val overallCorrectness = asString(record["overall_correctness"].orNull() ?: record["overallCorrectness"])
    val overallExplanation = asString(record["overall_explanation"].orNull() ?: record["overallExplanation"])
    val overallConfidenceScore = asNumber(record["overall_confidence_score"].orNull() ?: record["overallConfidenceScore"])

    // TS: `!overallCorrectness && !overallExplanation` — empty strings count as missing.
    if (findings.isEmpty() && overallCorrectness.isNullOrEmpty() && overallExplanation.isNullOrEmpty() && overallConfidenceScore == null) {
        return null
    }

    return CodexReview(
        findings = findings,
        overallCorrectness = overallCorrectness,
        overallExplanation = overallExplanation,
        overallConfidenceScore = overallConfidenceScore,
    )
}

private fun parseCodexReviewMessage(message: String): CodexReview? {
    val trimmed = message.trim()
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
    return try {
        normalizeCodexReviewJson(HapiJson.parseToJsonElement(trimmed))
    } catch (_: Exception) {
        null
    }
}

private fun normalizeAssistantUsage(message: JsonObject): UsageData? {
    val usage = asObject(message["usage"]) ?: return null
    val inputTokens = asNumber(usage["input_tokens"]) ?: return null
    val outputTokens = asNumber(usage["output_tokens"]) ?: return null
    return UsageData(
        inputTokens = inputTokens,
        outputTokens = outputTokens,
        cacheCreationInputTokens = asNumber(usage["cache_creation_input_tokens"]),
        cacheReadInputTokens = asNumber(usage["cache_read_input_tokens"]),
        serviceTier = asString(usage["service_tier"]),
        contextWindow = asNumber(usage["context_window"]),
    )
}

private fun normalizeAssistantOutput(
    messageId: String,
    localId: String?,
    createdAt: Long,
    data: JsonObject,
    meta: JsonElement?,
): NormalizedMessage? {
    val uuid = asString(data["uuid"]) ?: messageId
    val parentUUID = asString(data["parentUuid"])
    val isSidechain = jsTruthy(data["isSidechain"])
    val agentTimestamp = parseAgentTimestampMs(data["timestamp"])
    val parentToolUseId = asString(data["parentToolUseId"])

    val message = asObject(data["message"]) ?: return null

    val modelContent = message["content"]
    val blocks = mutableListOf<NormalizedAgentContent>()

    if (modelContent is JsonPrimitive && modelContent.isString) {
        blocks.add(NormalizedAgentContent.Text(text = modelContent.content, uuid = uuid, parentUUID = parentUUID))
    } else if (modelContent is JsonArray) {
        for (block in modelContent) {
            val record = asObject(block) ?: continue
            val type = asString(record["type"]) ?: continue
            if (type == "text") {
                val text = asString(record["text"]) ?: continue
                blocks.add(NormalizedAgentContent.Text(text = text, uuid = uuid, parentUUID = parentUUID))
                continue
            }
            if (type == "thinking") {
                val thinking = asString(record["thinking"]) ?: continue
                blocks.add(NormalizedAgentContent.Reasoning(text = thinking, uuid = uuid, parentUUID = parentUUID))
                continue
            }
            if (type == "tool_use") {
                val id = asString(record["id"]) ?: continue
                val name = asString(record["name"]) ?: "Tool"
                val input = if (record.containsKey("input")) record.getValue("input") else null
                val description = asObject(input)?.let { asString(it["description"]) }
                blocks.add(
                    NormalizedAgentContent.ToolUse(
                        id = id,
                        name = name,
                        input = input,
                        description = description,
                        uuid = uuid,
                        parentUUID = parentUUID,
                    )
                )
            }
        }
    }

    return NormalizedMessage.Agent(
        id = messageId,
        localId = localId,
        createdAt = createdAt,
        model = asString(message["model"]),
        isSidechain = isSidechain,
        parentToolUseId = parentToolUseId,
        content = blocks,
        meta = meta,
        agentTimestamp = agentTimestamp,
        usage = normalizeAssistantUsage(message),
    )
}

private fun normalizeUserOutput(
    messageId: String,
    localId: String?,
    createdAt: Long,
    data: JsonObject,
    meta: JsonElement?,
): NormalizedMessage? {
    val uuid = asString(data["uuid"]) ?: messageId
    val parentUUID = asString(data["parentUuid"])
    val isSidechain = jsTruthy(data["isSidechain"])
    val agentTimestamp = parseAgentTimestampMs(data["timestamp"])
    val parentToolUseId = asString(data["parentToolUseId"])

    val message = asObject(data["message"]) ?: return null

    val messageContent = message["content"]
    val contentString = (messageContent as? JsonPrimitive)?.takeIf { it.isString }?.content

    // All string-content user messages through the agent path are system-injected
    // (subagent prompts, task notifications, system reminders) — always emit as
    // sidechain so the uuid/parentUUID chain is preserved.
    if (contentString != null) {
        return NormalizedMessage.Agent(
            id = messageId,
            localId = localId,
            createdAt = createdAt,
            isSidechain = true,
            parentToolUseId = parentToolUseId,
            content = listOf(NormalizedAgentContent.Sidechain(uuid = uuid, parentUUID = parentUUID, prompt = contentString)),
            agentTimestamp = agentTimestamp,
        )
    }

    // Sidechain user messages with array content — extract text as the prompt.
    if (isSidechain && messageContent is JsonArray) {
        val textParts = messageContent.mapNotNull { b ->
            val record = asObject(b) ?: return@mapNotNull null
            if (asString(record["type"]) == "text") asString(record["text"]) else null
        }
        if (textParts.isNotEmpty()) {
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = true,
                parentToolUseId = parentToolUseId,
                content = listOf(
                    NormalizedAgentContent.Sidechain(uuid = uuid, parentUUID = parentUUID, prompt = textParts.joinToString("\n\n"))
                ),
                agentTimestamp = agentTimestamp,
            )
        }
    }

    // Non-sidechain array content that is all text blocks — a real user message
    // the CLI wrapped as agent output; emit in the user lane.
    if (!isSidechain && messageContent is JsonArray) {
        val textParts = messageContent.mapNotNull { b ->
            val record = asObject(b) ?: return@mapNotNull null
            if (asString(record["type"]) == "text") asString(record["text"]) else null
        }
        if (textParts.isNotEmpty() && textParts.size == messageContent.size) {
            return NormalizedMessage.User(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                text = textParts.joinToString("\n\n"),
                meta = meta,
                agentTimestamp = agentTimestamp,
            )
        }
    }

    val blocks = mutableListOf<NormalizedAgentContent>()

    if (messageContent is JsonArray) {
        for (block in messageContent) {
            val record = asObject(block) ?: continue
            val type = asString(record["type"]) ?: continue
            if (type == "text") {
                val text = asString(record["text"]) ?: continue
                blocks.add(NormalizedAgentContent.Text(text = text, uuid = uuid, parentUUID = parentUUID))
                continue
            }
            if (type == "tool_result") {
                val toolUseId = asString(record["tool_use_id"]) ?: continue
                val isError = jsTruthy(record["is_error"])
                val rawContent = if (record.containsKey("content")) record.getValue("content") else null
                // TS: `'toolUseResult' in data ? data.toolUseResult : null` then `?? rawContent`
                // — a null/absent embedded result falls back to the block content.
                val embeddedToolUseResult = data["toolUseResult"].orNull()

                blocks.add(
                    NormalizedAgentContent.ToolResult(
                        toolUseId = toolUseId,
                        content = embeddedToolUseResult ?: rawContent,
                        isError = isError,
                        uuid = uuid,
                        parentUUID = parentUUID,
                        permissions = normalizeToolResultPermissions(record["permissions"]),
                    )
                )
            }
        }
    }

    return NormalizedMessage.Agent(
        id = messageId,
        localId = localId,
        createdAt = createdAt,
        isSidechain = isSidechain,
        parentToolUseId = parentToolUseId,
        content = blocks,
        meta = meta,
        agentTimestamp = agentTimestamp,
    )
}

// ---------------------------------------------------------------------------
// agy (Antigravity)
// ---------------------------------------------------------------------------

/** "RUN_COMMAND" → "Run command". */
private fun humanizeAgyActionType(type: String): String {
    val words = type.lowercase().split("_").filter { it.isNotEmpty() }
    if (words.isEmpty()) return "Tool"
    return words.mapIndexed { i, w -> if (i == 0) w.replaceFirstChar { it.uppercaseChar() } else w }.joinToString(" ")
}

private val AGY_PREAMBLE_REGEX = Regex("^(?:Created At:.*(?:\\r?\\n|$))?(?:Completed At:.*(?:\\r?\\n|$))?")
private val AGY_READ_HEADER_REGEX =
    Regex("^(?:(?:File Path:|Total Lines:|Total Bytes:|Showing lines\\b).*(?:\\r?\\n|$))+")
private val AGY_LINE_NUMBER_NOTE_REGEX =
    Regex("^The following code has been modified to include a line number.*(?:\\r?\\n|$)")
private val AGY_CODE_ACTION_TRAILER_REGEX =
    Regex("\\s*If relevant, proactively run terminal commands[\\s\\S]*$")

/** Strip agy's per-action result framing (see the TS doc comment). */
fun stripAgyActionPreamble(content: String, name: String, rawActionName: String?): String {
    var result = AGY_PREAMBLE_REGEX.replaceFirst(content, "")

    if (name == "Read" || rawActionName == "VIEW_FILE") {
        result = AGY_READ_HEADER_REGEX.replaceFirst(result, "")
        result = AGY_LINE_NUMBER_NOTE_REGEX.replaceFirst(result, "")
    }

    if (name == "Write" || name == "Edit" || rawActionName == "CODE_ACTION") {
        result = AGY_CODE_ACTION_TRAILER_REGEX.replaceFirst(result, "")
    }

    return result.trim()
}

private val AGY_READ_TRAILER_REGEX = Regex("\\n?The above content (?:shows|does NOT show)[\\s\\S]*$")

fun stripAgyReadArtifacts(content: String): String =
    AGY_READ_TRAILER_REGEX.replaceFirst(content, "").trimEnd()

private val AGY_ECHOED_TASK_REGEX = Regex("\\n*\\[Message\\]\\s+timestamp=[\\s\\S]*$")

fun stripAgyEchoedTaskResult(text: String): String =
    AGY_ECHOED_TASK_REGEX.replaceFirst(text, "").trim()

const val AGY_TASK_LOG_TOOL = "AgyTaskLog"
const val AGY_ASYNC_TASK_TOOL = "AgyAsyncTask"
const val AGY_ERROR_TOOL = "AgyError"

data class AgyParsedMessage(val body: String, val summary: String, val isError: Boolean)

/** Strip agy SYSTEM_MESSAGE framing down to the task result + one-line summary. */
fun parseAgyAsyncTaskMessage(raw: String): AgyParsedMessage {
    var body = raw
    val contentEq = raw.indexOf("content=")
    val endTag = raw.indexOf("</SYSTEM_MESSAGE>")
    if (contentEq != -1) {
        body = raw.substring(contentEq + "content=".length, if (endTag != -1) endTag else raw.length)
    } else if (endTag != -1) {
        body = raw.substring(0, endTag)
    }
    body = body.replace(Regex("^[\\t ]+", RegexOption.MULTILINE), "").trim()

    val taskMatch = Regex("task-(\\d+)").find(raw)
    val taskLabel = if (taskMatch != null) "task-${taskMatch.groupValues[1]}" else "Background task"
    val failMatch = Regex("failed with exit code:?\\s*(\\d+)", RegexOption.IGNORE_CASE).find(body)
    val isError = failMatch != null
    var outcome = ""
    if (failMatch != null) {
        outcome = "failed (exit ${failMatch.groupValues[1]})"
    } else if (Regex("completed successfully", RegexOption.IGNORE_CASE).containsMatchIn(body)) {
        outcome = "completed"
    }
    val summary = if (outcome.isNotEmpty()) "$taskLabel · $outcome" else taskLabel
    return AgyParsedMessage(body = body, summary = summary, isError = isError)
}

data class AgyParsedError(val body: String, val summary: String)

/** Strip agy ERROR_MESSAGE bookkeeping + agent-directed guidance. */
fun parseAgyErrorMessage(raw: String): AgyParsedError {
    var body = raw.replace(Regex("^Created At:.*(?:\\r?\\n)?", RegexOption.MULTILINE), "")
    body = Regex("\\n?Guidance:[\\s\\S]*$").replaceFirst(body, "")
    body = Regex("\\n?Retries remaining:.*$", RegexOption.MULTILINE).replaceFirst(body, "")
    body = body.trim()
    val summary = if (Regex("invalid tool call", RegexOption.IGNORE_CASE).containsMatchIn(raw)) "Invalid tool call" else "Error"
    return AgyParsedError(body = body, summary = summary)
}

private data class AgyToolSpec(val name: String, val buildInput: (JsonObject) -> List<Pair<String, JsonElement?>>)

private val AGY_TOOL_SPECS: Map<String, AgyToolSpec> = mapOf(
    "run_command" to AgyToolSpec("Bash") { a -> listOf("command" to a["CommandLine"], "cwd" to a["Cwd"]) },
    "view_file" to AgyToolSpec("Read") { a -> listOf("file_path" to (a["AbsolutePath"].orNull() ?: a["RelativePath"])) },
    "write_to_file" to AgyToolSpec("Write") { a -> listOf("file_path" to a["TargetFile"], "content" to a["CodeContent"]) },
    "replace_file_content" to AgyToolSpec("Edit") { a ->
        listOf("file_path" to a["TargetFile"], "old_string" to a["TargetContent"], "new_string" to a["ReplacementContent"])
    },
    "grep_search" to AgyToolSpec("Grep") { a ->
        listOf("pattern" to (a["Query"].orNull() ?: a["SearchQuery"]), "path" to (a["SearchDirectory"].orNull() ?: a["SearchPath"]))
    },
    "list_dir" to AgyToolSpec("LS") { a -> listOf("path" to (a["DirectoryPath"].orNull() ?: a["AbsolutePath"])) },
)

private val AGY_ARG_KEY_MAP: Map<String, String> = mapOf(
    "CommandLine" to "command",
    "Cwd" to "cwd",
    "AbsolutePath" to "file_path",
    "RelativePath" to "file_path",
    "TargetFile" to "file_path",
    "FilePath" to "file_path",
    "Path" to "path",
    "DirectoryPath" to "path",
    "Query" to "query",
    "SearchQuery" to "query",
    "Pattern" to "pattern",
    "Url" to "url",
    "URL" to "url",
)

private val AGY_ARG_NOISE = setOf("toolAction", "toolSummary", "WaitMsBeforeAsync", "Blocking")

/** TS drop rule: `value === null || value === undefined || value === ''`. */
private fun isDroppedAgyValue(value: JsonElement?): Boolean {
    if (value == null || value is JsonNull) return true
    val primitive = value as? JsonPrimitive ?: return false
    return primitive.isString && primitive.content.isEmpty()
}

private fun normalizeAgyToolInput(args: JsonObject): JsonObject? {
    val out = LinkedHashMap<String, JsonElement>()
    for ((key, value) in args) {
        if (key in AGY_ARG_NOISE) continue
        if (isDroppedAgyValue(value)) continue
        out[AGY_ARG_KEY_MAP[key] ?: key] = value
    }
    return if (out.isNotEmpty()) JsonObject(out) else null
}

private data class AgyMappedTool(val name: String, val input: JsonObject?, val description: String?)

private fun mapAgyToolCall(toolName: String?, actionType: String, args: JsonObject?): AgyMappedTool {
    val description = args?.let { asString(it["toolSummary"]) }
    val spec = toolName?.let { AGY_TOOL_SPECS[it] }
    if (spec != null) {
        val built = LinkedHashMap<String, JsonElement>()
        for ((key, value) in spec.buildInput(args ?: JsonObject(emptyMap()))) {
            if (!isDroppedAgyValue(value)) built[key] = value!!
        }
        return AgyMappedTool(name = spec.name, input = if (built.isNotEmpty()) JsonObject(built) else null, description = description)
    }
    val name = humanizeAgyActionType(toolName ?: actionType)
    return AgyMappedTool(name = name, input = args?.let(::normalizeAgyToolInput), description = description)
}

// ---------------------------------------------------------------------------
// Skip filters + dispatch
// ---------------------------------------------------------------------------

fun isSkippableAgentContent(content: JsonElement?): Boolean {
    val record = asObject(content) ?: return false
    if (asString(record["type"]) != "output") return false
    val data = asObject(record["data"]) ?: return false
    if (jsTruthy(data["isMeta"]) || jsTruthy(data["isCompactSummary"])) return true
    val dataType = data["type"]
    if (asString(dataType) == "system" && asString(data["subtype"]) == "away_summary"
        && asString(data["content"])?.trim().isNullOrEmpty()
    ) return true
    if (asString(dataType) == "agy_message" && (asString(data["content"]) ?: "").trim().isEmpty()) return true
    return !isClaudeChatVisibleMessage(dataType, data["subtype"])
}

fun isCodexContent(content: JsonElement?): Boolean =
    asObject(content)?.let { asString(it["type"]) == AGENT_MESSAGE_PAYLOAD_TYPE } ?: false

private fun eventMessage(
    messageId: String,
    localId: String?,
    createdAt: Long,
    event: JsonObject,
    meta: JsonElement?,
    usage: UsageData? = null,
): NormalizedMessage.Event = NormalizedMessage.Event(
    id = messageId,
    localId = localId,
    createdAt = createdAt,
    event = AgentEvent.of(event),
    isSidechain = false,
    meta = meta,
    usage = usage,
)

@Suppress("CyclomaticComplexMethod", "LongMethod")
fun normalizeAgentRecord(
    messageId: String,
    localId: String?,
    createdAt: Long,
    content: JsonElement?,
    meta: JsonElement?,
): NormalizedMessage? {
    val (record, contentType) = typedRecordOrNull(content) ?: return null

    if (contentType == "output") {
        val data = asObject(record["data"]) ?: return null
        val dataType = asString(data["type"]) ?: return null

        // Skip meta/compact-summary messages (parity with hapi-app).
        if (jsTruthy(data["isMeta"])) return null
        if (jsTruthy(data["isCompactSummary"])) return null
        if (!isClaudeChatVisibleMessage(data["type"], data["subtype"])) return null

        if (dataType == "assistant") {
            return normalizeAssistantOutput(messageId, localId, createdAt, data, meta)
        }
        if (dataType == "user") {
            return normalizeUserOutput(messageId, localId, createdAt, data, meta)
        }
        if (dataType == "summary") {
            val summary = asString(data["summary"])
            if (summary != null) {
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(NormalizedAgentContent.Summary(summary)),
                    meta = meta,
                )
            }
        }
        val subtype = asString(data["subtype"])
        if (dataType == "system" && subtype == "api_error") {
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "api-error")
                put("retryAttempt", jsNumber(asNumber(data["retryAttempt"]) ?: 0.0))
                put("maxRetries", jsNumber(asNumber(data["maxRetries"]) ?: 0.0))
                // TS `error: data.error` — an absent key stays absent after stringify.
                data["error"]?.let { put("error", it) }
            }, meta)
        }
        if (dataType == "system" && subtype == "turn_duration") {
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "turn-duration")
                put("durationMs", jsNumber(asNumber(data["durationMs"]) ?: 0.0))
                asString(data["messageId"])?.let { put("targetMessageId", it) }
            }, meta)
        }
        if (dataType == "system" && subtype == "away_summary") {
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "recap")
                put("text", asString(data["content"]) ?: "")
            }, meta)
        }
        if (dataType == "system" && subtype == "microcompact_boundary") {
            val metadata = asObject(data["microcompactMetadata"])
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "microcompact")
                put("trigger", metadata?.let { asString(it["trigger"]) } ?: "auto")
                put("preTokens", jsNumber(metadata?.let { asNumber(it["preTokens"]) } ?: 0.0))
                put("tokensSaved", jsNumber(metadata?.let { asNumber(it["tokensSaved"]) } ?: 0.0))
            }, meta)
        }
        if (dataType == "system" && subtype == "compact_boundary") {
            val metadata = asObject(data["compactMetadata"])
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "compact")
                put("trigger", metadata?.let { asString(it["trigger"]) } ?: "auto")
                put("preTokens", jsNumber(metadata?.let { asNumber(it["preTokens"]) } ?: 0.0))
            }, meta)
        }

        if (dataType == "agy_message") {
            val text = stripAgyEchoedTaskResult(asString(data["content"]) ?: "")
            if (text.isBlank()) return null
            val taskLog = Regex("^Inside the task-(\\d+) log\\b").find(text)
            if (taskLog != null) {
                val toolCallId = "$messageId:tasklog"
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(
                        NormalizedAgentContent.ToolUse(
                            id = toolCallId,
                            name = AGY_TASK_LOG_TOOL,
                            input = buildJsonObject { put("task", "task-${taskLog.groupValues[1]}") },
                            description = null,
                            uuid = messageId,
                            parentUUID = null,
                        ),
                        NormalizedAgentContent.ToolResult(
                            toolUseId = toolCallId,
                            content = JsonPrimitive(""),
                            isError = false,
                            uuid = messageId,
                            parentUUID = null,
                        ),
                    ),
                    meta = meta,
                )
            }
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                content = listOf(NormalizedAgentContent.Text(text = text, uuid = messageId, parentUUID = null)),
                model = asString(data["model"]),
                meta = meta,
            )
        }

        if (dataType == "agy_tool_action") {
            val rawActionName = asString(data["name"]) ?: "Tool"
            val toolCallId = asString(data["toolUseId"]) ?: messageId

            val name: String
            val input: JsonObject?
            val description: String?
            var resultContent: String
            var isError = false
            if (rawActionName == "SYSTEM_MESSAGE") {
                val parsed = parseAgyAsyncTaskMessage(asString(data["content"]) ?: "")
                name = AGY_ASYNC_TASK_TOOL
                input = null
                description = parsed.summary
                resultContent = parsed.body
                isError = parsed.isError
            } else if (rawActionName == "ERROR_MESSAGE") {
                val parsed = parseAgyErrorMessage(asString(data["content"]) ?: "")
                name = AGY_ERROR_TOOL
                input = null
                description = parsed.summary
                resultContent = parsed.body
                isError = true
            } else {
                val mapped = mapAgyToolCall(asString(data["toolName"]), rawActionName, asObject(data["input"]))
                name = mapped.name
                input = mapped.input
                description = mapped.description
                resultContent = stripAgyActionPreamble(asString(data["content"]) ?: "", name, rawActionName)
                if (name == "Read" || rawActionName == "VIEW_FILE") resultContent = stripAgyReadArtifacts(resultContent)
            }
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                content = listOf(
                    NormalizedAgentContent.ToolUse(
                        id = toolCallId,
                        name = name,
                        input = input,
                        description = description,
                        nativeKind = if (name == "Read" || rawActionName == "VIEW_FILE") "agy-numbered-read" else null,
                        uuid = messageId,
                        parentUUID = null,
                    ),
                    NormalizedAgentContent.ToolResult(
                        toolUseId = toolCallId,
                        content = JsonPrimitive(resultContent),
                        isError = isError,
                        uuid = messageId,
                        parentUUID = null,
                    ),
                ),
                meta = meta,
            )
        }
        return null
    }

    if (contentType == "event") {
        val event = normalizeAgentEvent(record["data"]) ?: return null
        return NormalizedMessage.Event(
            id = messageId,
            localId = localId,
            createdAt = createdAt,
            event = event,
            isSidechain = false,
            meta = meta,
        )
    }

    if (contentType == AGENT_MESSAGE_PAYLOAD_TYPE) {
        val data = asObject(record["data"]) ?: return null
        val dataType = asString(data["type"]) ?: return null

        if (dataType == "agent-run-start" || dataType == "agent-run-update" || dataType == "agent-run-trace") {
            return eventMessage(messageId, localId, createdAt, data, meta)
        }

        if (dataType == "generated-image") {
            val imageId = asString(data["imageId"].orNull() ?: data["image_id"]) ?: return null
            val uuid = asString(data["id"]) ?: messageId
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                content = listOf(
                    NormalizedAgentContent.GeneratedImage(
                        imageId = imageId,
                        fileName = asString(data["fileName"].orNull() ?: data["file_name"]) ?: "generated-image",
                        mimeType = asString(data["mimeType"].orNull() ?: data["mime_type"]),
                        uuid = uuid,
                        parentUUID = null,
                        source = inlineMediaSourceFromWire(data["source"]),
                    )
                ),
                meta = meta,
            )
        }

        if (dataType == "error") {
            val message = asString(data["message"])
            if (message != null) {
                return eventMessage(messageId, localId, createdAt, buildJsonObject {
                    put("type", "error")
                    put("message", message)
                }, meta)
            }
        }

        if (dataType == "message") {
            val message = asString(data["message"])
            if (message != null) {
                val streamId = asString(data["id"])
                val isPiStreamSnapshot = data["streamSnapshot"] == JsonPrimitive(true)
                    || (streamId != null && Regex("^pi-.+-turn-\\d+-message-\\d+-text-\\d+$").matches(streamId))
                val review = if (isPiStreamSnapshot) null else parseCodexReviewMessage(message)
                if (review != null) {
                    return NormalizedMessage.Agent(
                        id = messageId,
                        localId = localId,
                        createdAt = createdAt,
                        isSidechain = false,
                        content = listOf(
                            NormalizedAgentContent.CodexReviewContent(review = review, uuid = messageId, parentUUID = null)
                        ),
                        meta = meta,
                    )
                }
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(
                        NormalizedAgentContent.Text(text = message, uuid = messageId, streamId = streamId, parentUUID = null)
                    ),
                    meta = meta,
                )
            }
        }

        if (dataType == "reasoning") {
            val message = asString(data["message"])
            if (message != null) {
                val streamId = asString(data["id"]) ?: messageId
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(
                        NormalizedAgentContent.Reasoning(text = message, uuid = messageId, streamId = streamId, parentUUID = null)
                    ),
                    meta = meta,
                )
            }
        }

        if (dataType == "context_compacted") {
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "compact")
                put("trigger", asString(data["trigger"]) ?: "auto")
                put("preTokens", jsNumber(asNumber(data["preTokens"].orNull() ?: data["pre_tokens"]) ?: 0.0))
            }, meta)
        }

        if (dataType == "compact-summary") {
            val summary = asString(data["summary"])
            if (summary != null) {
                return eventMessage(messageId, localId, createdAt, buildJsonObject {
                    put("type", "compact-summary")
                    put("summary", summary)
                    asNumber(data["tokensBefore"])?.let { put("tokensBefore", jsNumber(it)) }
                    asNumber(data["estimatedTokensAfter"])?.let { put("estimatedTokensAfter", jsNumber(it)) }
                }, meta)
            }
        }

        if (dataType == "token_count") {
            val usage = normalizeCodexTokenUsage(data["info"], data) ?: return null
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "token-count")
                data["info"]?.let { put("info", it) }
            }, meta, usage = usage)
        }

        if (dataType == "thread_goal_updated") {
            val goal = normalizeThreadGoal(data["goal"]) ?: return null
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "thread-goal-updated")
                put(
                    "threadId",
                    asString(data["threadId"].orNull() ?: data["thread_id"])?.let(::JsonPrimitive)
                        ?: goal.getValue("threadId"),
                )
                asString(data["turnId"].orNull() ?: data["turn_id"])?.let { put("turnId", it) }
                put("goal", goal)
            }, meta)
        }

        if (dataType == "thread_goal_cleared") {
            return eventMessage(messageId, localId, createdAt, buildJsonObject {
                put("type", "thread-goal-cleared")
                asString(data["threadId"].orNull() ?: data["thread_id"])?.let { put("threadId", it) }
            }, meta)
        }

        if (dataType == "tool-call") {
            val callId = asString(data["callId"])
            if (callId != null) {
                val uuid = asString(data["id"]) ?: messageId
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(
                        NormalizedAgentContent.ToolUse(
                            id = callId,
                            name = asString(data["name"]) ?: "unknown",
                            input = data["input"],
                            description = asString(data["description"]),
                            nativeTitle = asString(data["nativeTitle"].orNull() ?: data["title"]),
                            nativeKind = asString(data["nativeKind"].orNull() ?: data["kind"]),
                            hasProgress = data.containsKey("progress"),
                            progress = data["progress"],
                            uuid = uuid,
                            parentUUID = null,
                        )
                    ),
                    meta = meta,
                )
            }
        }

        if (dataType == "tool-call-result") {
            val callId = asString(data["callId"])
            if (callId != null) {
                val uuid = asString(data["id"]) ?: messageId
                return NormalizedMessage.Agent(
                    id = messageId,
                    localId = localId,
                    createdAt = createdAt,
                    isSidechain = false,
                    content = listOf(
                        NormalizedAgentContent.ToolResult(
                            toolUseId = callId,
                            content = if (data.containsKey("output")) data.getValue("output") else null,
                            isError = jsTruthy(data["is_error"]),
                            uuid = uuid,
                            parentUUID = null,
                        )
                    ),
                    meta = meta,
                )
            }
        }

        if (dataType == "plan") {
            val plan = normalizePlanEntries(data["entries"].orNull() ?: data["items"].orNull() ?: data)
            if (plan.isEmpty()) return null
            val uuid = asString(data["id"]) ?: messageId
            val planJson = planToJson(plan)
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                content = listOf(
                    NormalizedAgentContent.ToolUse(
                        id = "cursor-plan-state",
                        name = "update_plan",
                        input = buildJsonObject {
                            put("plan", planJson)
                            put("source", "cursor")
                        },
                        description = null,
                        uuid = uuid,
                        parentUUID = null,
                    ),
                    NormalizedAgentContent.ToolResult(
                        toolUseId = "cursor-plan-state",
                        content = buildJsonObject {
                            put("plan", planJson)
                            put("source", "cursor")
                        },
                        isError = false,
                        uuid = uuid,
                        parentUUID = null,
                    ),
                ),
                meta = meta,
            )
        }

        if (dataType == "plan_update") {
            val plan = normalizePlanEntries(
                data["plan"].orNull() ?: data["update"].orNull() ?: data["items"].orNull() ?: data["steps"].orNull() ?: data
            )
            if (plan.isEmpty()) return null
            val uuid = asString(data["id"]) ?: messageId
            val planJson = planToJson(plan)
            return NormalizedMessage.Agent(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                isSidechain = false,
                content = listOf(
                    NormalizedAgentContent.ToolUse(
                        id = "codex-plan-state",
                        name = "update_plan",
                        input = buildJsonObject {
                            put("plan", planJson)
                            put("source", "codex")
                        },
                        description = null,
                        uuid = uuid,
                        parentUUID = null,
                    ),
                    NormalizedAgentContent.ToolResult(
                        toolUseId = "codex-plan-state",
                        content = buildJsonObject {
                            put("plan", planJson)
                            put("source", "codex")
                            put("status", "updated")
                        },
                        isError = false,
                        uuid = "$uuid:result",
                        parentUUID = null,
                    ),
                ),
                meta = meta,
            )
        }
    }

    return null
}

package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Port of `web/scripts/fixtures/projection.ts` — the NORMATIVE projection of
 * the chat pipeline output. Keep in sync with `shared/fixtures/README.md`.
 *
 * Optional keys are emitted only when the TS value would not be `undefined`;
 * explicit nulls ([JsonNull], nullable `localId`/`mimeType`/`contextWindow`)
 * are kept as JSON null exactly like `JSON.stringify` keeps them.
 */

private fun projectAttachments(attachments: List<ChatAttachment>?): JsonArray? {
    if (attachments.isNullOrEmpty()) return null
    return JsonArray(
        attachments.map { attachment ->
            val obj = LinkedHashMap<String, JsonElement>()
            obj["id"] = JsonPrimitive(attachment.id)
            obj["filename"] = JsonPrimitive(attachment.filename)
            obj["mimeType"] = JsonPrimitive(attachment.mimeType)
            obj["size"] = jsNumber(attachment.size)
            obj["path"] = JsonPrimitive(attachment.path)
            JsonObject(obj)
        }
    )
}

private fun projectPermission(permission: ToolPermission?): JsonObject? {
    if (permission == null) return null
    val projected = LinkedHashMap<String, JsonElement>()
    projected["status"] = JsonPrimitive(permission.status)
    permission.mode?.let { projected["mode"] = JsonPrimitive(it) }
    permission.decision?.let { projected["decision"] = JsonPrimitive(it) }
    permission.allowedTools?.let { tools -> projected["allowedTools"] = JsonArray(tools.map(::JsonPrimitive)) }
    permission.answers?.let { projected["answers"] = it }
    permission.reason?.let { projected["reason"] = JsonPrimitive(it) }
    return JsonObject(projected)
}

private fun projectTool(tool: ChatToolCall): JsonObject {
    val projected = LinkedHashMap<String, JsonElement>()
    projected["id"] = JsonPrimitive(tool.id)
    projected["name"] = JsonPrimitive(tool.name)
    projected["state"] = JsonPrimitive(tool.state)
    tool.input?.let { projected["input"] = it }
    tool.result?.let { projected["result"] = it }
    projectPermission(tool.permission)?.let { projected["permission"] = it }
    return JsonObject(projected)
}

private fun projectBlockBase(kind: String, id: String, createdAt: Long, invokedAt: Long?): LinkedHashMap<String, JsonElement> {
    val projected = LinkedHashMap<String, JsonElement>()
    projected["kind"] = JsonPrimitive(kind)
    projected["id"] = JsonPrimitive(id)
    projected["createdAt"] = JsonPrimitive(createdAt)
    if (invokedAt != null) {
        projected["invokedAt"] = JsonPrimitive(invokedAt)
    }
    return projected
}

private fun projectReview(review: CodexReview): JsonObject {
    val obj = LinkedHashMap<String, JsonElement>()
    obj["findings"] = JsonArray(
        review.findings.map { finding ->
            val f = LinkedHashMap<String, JsonElement>()
            f["title"] = JsonPrimitive(finding.title)
            f["body"] = JsonPrimitive(finding.body)
            f["priority"] = finding.priority?.let(::jsNumber) ?: JsonNull
            f["confidenceScore"] = finding.confidenceScore?.let(::jsNumber) ?: JsonNull
            f["filePath"] = finding.filePath?.let(::JsonPrimitive) ?: JsonNull
            f["lineStart"] = finding.lineStart?.let(::jsNumber) ?: JsonNull
            f["lineEnd"] = finding.lineEnd?.let(::jsNumber) ?: JsonNull
            JsonObject(f)
        }
    )
    obj["overallCorrectness"] = review.overallCorrectness?.let(::JsonPrimitive) ?: JsonNull
    obj["overallExplanation"] = review.overallExplanation?.let(::JsonPrimitive) ?: JsonNull
    obj["overallConfidenceScore"] = review.overallConfidenceScore?.let(::jsNumber) ?: JsonNull
    return JsonObject(obj)
}

private fun nullableString(value: String?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

/** Project one reduced ChatBlock down to its normative fields. */
fun projectChatBlock(block: ChatBlock): JsonObject {
    val projected = projectBlockBase(block.kind, block.id, block.createdAt, block.invokedAt)
    when (block) {
        is UserTextBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["text"] = JsonPrimitive(block.text)
            projectAttachments(block.attachments)?.let { projected["attachments"] = it }
        }
        is AgentTextBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["text"] = JsonPrimitive(block.text)
        }
        is AgentReasoningBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["text"] = JsonPrimitive(block.text)
        }
        is CliOutputBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["text"] = JsonPrimitive(block.text)
            projected["source"] = JsonPrimitive(block.source)
        }
        is CodexReviewBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["review"] = projectReview(block.review)
        }
        is GeneratedImageBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["imageId"] = JsonPrimitive(block.imageId)
            projected["fileName"] = JsonPrimitive(block.fileName)
            projected["mimeType"] = nullableString(block.mimeType)
        }
        is AgentEventBlock -> {
            projected["event"] = block.event.raw
        }
        is ToolCallBlock -> {
            projected["localId"] = nullableString(block.localId)
            projected["tool"] = projectTool(block.tool)
            if (block.children.isNotEmpty()) {
                projected["children"] = JsonArray(block.children.map(::projectChatBlock))
            }
        }
    }
    return JsonObject(projected)
}

/** Project a visible block (post tool-grouping). */
fun projectVisibleChatBlock(block: VisibleChatBlock): JsonObject {
    if (block !is ToolGroupBlock) {
        return projectChatBlock(block as ChatBlock)
    }
    val projected = projectBlockBase(block.kind, block.id, block.createdAt, block.invokedAt)
    projected["firstToolId"] = JsonPrimitive(block.firstToolId)
    projected["lastToolId"] = JsonPrimitive(block.lastToolId)
    projected["tools"] = JsonArray(block.tools.map(::projectChatBlock))
    return JsonObject(projected)
}

/** Normative usage projection. */
fun projectLatestUsage(usage: LatestUsage?): JsonElement {
    if (usage == null) return JsonNull
    val projected = LinkedHashMap<String, JsonElement>()
    projected["inputTokens"] = jsNumber(usage.inputTokens)
    projected["outputTokens"] = jsNumber(usage.outputTokens)
    projected["contextSize"] = jsNumber(usage.contextSize)
    projected["contextWindow"] = usage.contextWindow?.let(::jsNumber) ?: JsonNull
    return JsonObject(projected)
}

package app.hapi.protocol.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** Port of `web/src/chat/normalizeUser.ts`. */

private fun parseAttachments(raw: JsonElement?): List<ChatAttachment>? {
    val array = raw as? JsonArray ?: return null
    val attachments = mutableListOf<ChatAttachment>()
    for (item in array) {
        val record = asObject(item) ?: continue
        val id = asString(record["id"]) ?: continue
        val filename = asString(record["filename"]) ?: continue
        val mimeType = asString(record["mimeType"]) ?: continue
        val size = asNumber(record["size"]) ?: continue
        val path = asString(record["path"]) ?: continue
        attachments.add(
            ChatAttachment(
                id = id,
                filename = filename,
                mimeType = mimeType,
                size = size,
                path = path,
                previewUrl = asString(record["previewUrl"]),
            )
        )
    }
    return attachments.takeIf { it.isNotEmpty() }
}

fun normalizeUserRecord(
    messageId: String,
    localId: String?,
    createdAt: Long,
    content: JsonElement?,
    meta: JsonElement?,
): NormalizedMessage? {
    if (content is JsonPrimitive && content.isString) {
        return NormalizedMessage.User(
            id = messageId,
            localId = localId,
            createdAt = createdAt,
            text = content.content,
            isSidechain = false,
            meta = meta,
        )
    }

    val record = asObject(content)
    if (record != null && asString(record["type"]) == "text") {
        val text = asString(record["text"])
        if (text != null) {
            return NormalizedMessage.User(
                id = messageId,
                localId = localId,
                createdAt = createdAt,
                text = text,
                attachments = parseAttachments(record["attachments"]),
                isSidechain = false,
                meta = meta,
            )
        }
    }

    return null
}

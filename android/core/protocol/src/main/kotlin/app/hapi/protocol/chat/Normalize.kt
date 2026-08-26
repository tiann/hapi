package app.hapi.protocol.chat

import app.hapi.protocol.wire.DecryptedMessage

/** Port of `web/src/chat/normalize.ts` — the decode-tree entry point. */

private fun stringifiedAgentFallback(
    message: DecryptedMessage,
    text: String,
    meta: kotlinx.serialization.json.JsonElement?,
    invokedAt: Long?,
): NormalizedMessage = NormalizedMessage.Agent(
    id = message.id,
    localId = message.localId,
    createdAt = message.createdAt,
    isSidechain = false,
    content = listOf(NormalizedAgentContent.Text(text = text, uuid = message.id, parentUUID = null)),
    meta = meta,
    status = null,
    originalText = null,
    invokedAt = invokedAt,
)

fun normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage? {
    val record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record == null) {
        // No envelope: stringify the whole content. (TS sets no invokedAt here.)
        return stringifiedAgentFallback(message, safeStringify(message.content), meta = null, invokedAt = null)
    }

    val invokedAt = message.invokedAtOrNull

    if (record.role == "user") {
        val normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return if (normalized is NormalizedMessage.User) {
            normalized.copy(invokedAt = invokedAt)
        } else {
            NormalizedMessage.User(
                id = message.id,
                localId = message.localId,
                createdAt = message.createdAt,
                isSidechain = false,
                text = safeStringify(record.content),
                meta = record.meta,
                invokedAt = invokedAt,
            )
        }
    }
    if (record.role == "agent") {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        val normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (normalized == null && isCodexContent(record.content)) {
            return null
        }
        return when (normalized) {
            is NormalizedMessage.User -> normalized.copy(invokedAt = invokedAt)
            is NormalizedMessage.Agent -> normalized.copy(invokedAt = invokedAt)
            is NormalizedMessage.Event -> normalized.copy(invokedAt = invokedAt)
            null -> stringifiedAgentFallback(message, safeStringify(record.content), meta = record.meta, invokedAt = invokedAt)
        }
    }

    return stringifiedAgentFallback(message, safeStringify(record.content), meta = record.meta, invokedAt = invokedAt)
}

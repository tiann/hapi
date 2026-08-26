package app.hapi.protocol.wire

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * One stored chat message as returned by `GET /api/sessions/:id/messages` and
 * the `message-received` SSE event. Mirrors `DecryptedMessageSchema`
 * (`shared/src/schemas.ts`).
 *
 * [content] is the raw role-wrapped envelope — decoding it into renderable
 * blocks is the chat-pipeline milestone (`docs/api/client-contract/messages.md`),
 * not a wire concern.
 *
 * [invokedAt] is tri-state on purpose (`docs/api/client-contract/pagination.md`):
 * explicit `null` = the message is still queued; a number = when the agent
 * consumed it; **absent** = already invoked (pre-V8 hubs omit the field). A
 * plain `Long?` would silently merge "queued" with "legacy invoked", so this
 * class carries a hand-written serializer.
 */
@Serializable(with = DecryptedMessageSerializer::class)
data class DecryptedMessage(
    val id: String,
    val seq: Long? = null,
    val localId: String? = null,
    val content: JsonElement = JsonNull,
    val createdAt: Long,
    val invokedAt: OptionalField<Long?> = OptionalField.Absent,
    val scheduledAt: Long? = null,
    val deliveryState: String? = null,
) {
    /** `invokedAt` collapsed to a plain value (both absent and `null` → null). */
    val invokedAtOrNull: Long? get() = invokedAt.valueOrNull()

    /** Display position: `invokedAt ?? createdAt` (see pagination.md "Position key"). */
    val positionAt: Long get() = invokedAtOrNull ?: createdAt
}

internal object DecryptedMessageSerializer : KSerializer<DecryptedMessage> {
    override val descriptor: SerialDescriptor =
        SerialDescriptor("app.hapi.protocol.wire.DecryptedMessage", JsonObject.serializer().descriptor)

    override fun deserialize(decoder: Decoder): DecryptedMessage {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("DecryptedMessage supports JSON only")
        val obj = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("DecryptedMessage must be a JSON object")
        return DecryptedMessage(
            id = obj["id"].stringOrNull
                ?: throw SerializationException("DecryptedMessage.id must be a string"),
            seq = obj["seq"].longOrNull,
            localId = obj["localId"].stringOrNull,
            content = obj["content"] ?: JsonNull,
            createdAt = obj["createdAt"].longOrNull
                ?: throw SerializationException("DecryptedMessage.createdAt must be a number"),
            invokedAt = if (obj.containsKey("invokedAt")) {
                OptionalField.Present(obj["invokedAt"].longOrNull)
            } else {
                OptionalField.Absent
            },
            scheduledAt = obj["scheduledAt"].longOrNull,
            deliveryState = obj["deliveryState"].stringOrNull,
        )
    }

    override fun serialize(encoder: Encoder, value: DecryptedMessage) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("DecryptedMessage supports JSON only")
        output.encodeJsonElement(buildJsonObject {
            put("id", JsonPrimitive(value.id))
            put("seq", value.seq?.let(::JsonPrimitive) ?: JsonNull)
            put("localId", value.localId?.let(::JsonPrimitive) ?: JsonNull)
            put("content", value.content)
            put("createdAt", JsonPrimitive(value.createdAt))
            if (value.invokedAt is OptionalField.Present) {
                put("invokedAt", value.invokedAt.value?.let(::JsonPrimitive) ?: JsonNull)
            }
            value.scheduledAt?.let { put("scheduledAt", JsonPrimitive(it)) }
            value.deliveryState?.let { put("deliveryState", JsonPrimitive(it)) }
        })
    }
}

/**
 * User-message attachment descriptor (`AttachmentMetadataSchema`). Also the
 * shape sent back in `POST /sessions/:id/messages` bodies.
 */
@Serializable
data class AttachmentMetadata(
    val id: String,
    val filename: String,
    val mimeType: String,
    val size: Long,
    val path: String,
    val previewUrl: String? = null,
)

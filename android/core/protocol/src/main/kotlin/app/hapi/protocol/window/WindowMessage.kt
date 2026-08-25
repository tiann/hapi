package app.hapi.protocol.window

import app.hapi.protocol.wire.AttachmentMetadata
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.hasExplicitNullInvokedAt
import app.hapi.protocol.wire.isUserMessage
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Client-side send state of an optimistic user message. The web reference
 * extends the wire `DecryptedMessage` with `status?: MessageStatus`
 * (`web/src/types/api.ts`); the wire never carries it — servers echo rows
 * without a status and the client re-attaches it during merge.
 */
enum class MessageStatus(val wire: String) {
    Queued("queued"),
    Sending("sending"),
    Sent("sent"),
    Failed("failed"),
    Indeterminate("indeterminate"),
    ;

    companion object {
        fun fromWire(value: String?): MessageStatus? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * One row of the message window: the wire [DecryptedMessage] plus the
 * client-side [status]. Mirrors the web's `DecryptedMessage & {status?}`.
 *
 * Identity matters: `applyLatestResponse`'s request-baseline comparison is by
 * **reference** (web `!==`), so transitions must only create new instances for
 * rows they actually change — which every function in this package does.
 */
@Serializable(with = WindowMessageSerializer::class)
data class WindowMessage(
    val wire: DecryptedMessage,
    val status: MessageStatus? = null,
) {
    val id: String get() = wire.id
    val seq: Long? get() = wire.seq
    val localId: String? get() = wire.localId
    val createdAt: Long get() = wire.createdAt

    /** Position time `invokedAt ?? createdAt` (collapsed tri-state). */
    val positionAt: Long get() = wire.positionAt

    val invokedAtOrNull: Long? get() = wire.invokedAtOrNull

    /** A row is optimistic iff it has a localId and `id === localId`. */
    val isOptimistic: Boolean
        get() = wire.localId != null && wire.id == wire.localId

    /**
     * Web `isQueuedForInvocation`: a user message whose `invokedAt` is an
     * explicit `null` and whose send did not fail. Only these rows sit in the
     * queued bar and survive window trims.
     */
    val isQueuedForInvocation: Boolean
        get() = wire.isUserMessage && wire.hasExplicitNullInvokedAt && status != MessageStatus.Failed

    /** Copy with `invokedAt` stamped to an explicit number. */
    fun withInvokedAt(invokedAt: Long): WindowMessage =
        copy(wire = wire.copy(invokedAt = OptionalField.Present(invokedAt)))
}

fun DecryptedMessage.asWindowMessage(status: MessageStatus? = null): WindowMessage =
    WindowMessage(
        this,
        status ?: if (deliveryState == "indeterminate") MessageStatus.Indeterminate else null,
    )

/**
 * Serializes as the wire object plus an optional `status` key — the same
 * shape the web persists (and the pagination fixtures use for op inputs).
 */
internal object WindowMessageSerializer : KSerializer<WindowMessage> {
    override val descriptor: SerialDescriptor =
        SerialDescriptor("app.hapi.protocol.window.WindowMessage", JsonObject.serializer().descriptor)

    override fun deserialize(decoder: Decoder): WindowMessage {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("WindowMessage supports JSON only")
        val obj = input.decodeJsonElement() as? JsonObject
            ?: throw SerializationException("WindowMessage must be a JSON object")
        return WindowMessage(
            wire = input.json.decodeFromJsonElement(DecryptedMessage.serializer(), obj),
            status = MessageStatus.fromWire(obj["status"].stringOrNull),
        )
    }

    override fun serialize(encoder: Encoder, value: WindowMessage) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("WindowMessage supports JSON only")
        val wireObject = output.json.encodeToJsonElement(DecryptedMessage.serializer(), value.wire) as JsonObject
        output.encodeJsonElement(buildJsonObject {
            wireObject.forEach { (key, element) -> put(key, element) }
            value.status?.let { put("status", JsonPrimitive(it.wire)) }
        })
    }
}

/**
 * Builds the optimistic row appended on send, mirroring
 * `createOptimisticMessage` in `web/src/hooks/mutations/useSendMessage.ts`
 * and the contract's "Optimistic sends" lifecycle: `id = localId`,
 * `seq = null`, explicit `invokedAt: null` (so the strict-null queued check
 * matches), content `{role:'user', content:{type:'text', text, attachments?},
 * meta:{deliveryMode}}`.
 */
fun buildOptimisticMessage(
    localId: String,
    text: String,
    createdAt: Long,
    attachments: List<AttachmentMetadata>? = null,
    scheduledAt: Long? = null,
    deliveryMode: String = "queue",
    status: MessageStatus = MessageStatus.Sending,
): WindowMessage {
    val content = buildJsonObject {
        put("role", "user")
        put("content", buildJsonObject {
            put("type", "text")
            put("text", text)
            if (attachments != null) {
                put(
                    "attachments",
                    app.hapi.protocol.wire.HapiJson.encodeToJsonElement(
                        ListSerializer(AttachmentMetadata.serializer()),
                        attachments,
                    ),
                )
            }
        })
        put("meta", buildJsonObject { put("deliveryMode", deliveryMode) })
    }
    return WindowMessage(
        wire = DecryptedMessage(
            id = localId,
            seq = null,
            localId = localId,
            content = content,
            createdAt = createdAt,
            invokedAt = OptionalField.Present(null),
            scheduledAt = scheduledAt,
        ),
        status = status,
    )
}

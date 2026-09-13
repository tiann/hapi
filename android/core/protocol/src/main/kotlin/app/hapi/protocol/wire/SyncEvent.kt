package app.hapi.protocol.wire

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The SSE event union (`SyncEventSchema`, `shared/src/schemas.ts`;
 * `docs/api/client-contract/sse.md` — 13 types, discriminated on `type`).
 * Decode with [SyncEvents.parse]; there is no polymorphic serializer because
 * frames arrive one JSON document per SSE `data:` line and unknown /
 * malformed frames must degrade to [Unknown] instead of throwing.
 *
 * `session-updated` / `session-added` / `machine-updated` keep their `data`
 * raw: resolving full-object vs patch is the caller's job (full [Session] /
 * [Machine] via [HapiJson], patch via [SessionPatches.parse] /
 * [MachinePatches.parse], anything else → REST refetch fallback).
 */
sealed interface SyncEvent {
    val namespace: String?

    @Serializable
    data class SessionAdded(
        override val namespace: String? = null,
        val sessionId: String,
        val data: JsonElement? = null,
    ) : SyncEvent

    @Serializable
    data class SessionUpdated(
        override val namespace: String? = null,
        val sessionId: String,
        /** Full `Session` or `SessionPatch`; absent/unparseable ⇒ refetch. */
        val data: JsonElement? = null,
    ) : SyncEvent

    @Serializable
    data class SessionRemoved(
        override val namespace: String? = null,
        val sessionId: String,
    ) : SyncEvent

    @Serializable
    data class MessageReceived(
        override val namespace: String? = null,
        val sessionId: String,
        val message: DecryptedMessage,
    ) : SyncEvent

    /** History changed structurally (rewind/fork/import/clear): drop the window, tail-sync. */
    @Serializable
    data class MessagesInvalidated(
        override val namespace: String? = null,
        val sessionId: String,
    ) : SyncEvent

    @Serializable
    data class ScheduledMatured(
        override val namespace: String? = null,
        val sessionId: String,
    ) : SyncEvent

    @Serializable
    data class SessionEnded(
        override val namespace: String? = null,
        val sessionId: String,
        /** `'completed' | 'terminated' | 'error' | 'handoff' | 'cleared'`. */
        val reason: String? = null,
    ) : SyncEvent

    /**
     * Not `@Serializable`: built by hand in [SyncEvents.parse] because `data`
     * is tri-state — `Present(JsonNull)` = machine **removed**,
     * `Present(object)` = full `Machine` or `MachinePatch`, [OptionalField.Absent]
     * = refetch machines (`docs/api/client-contract/sse.md`). A nullable
     * `JsonElement?` property would collapse the first and last cases.
     */
    data class MachineUpdated(
        override val namespace: String? = null,
        val machineId: String,
        val data: OptionalField<JsonElement> = OptionalField.Absent,
    ) : SyncEvent

    @Serializable
    data class Toast(
        override val namespace: String? = null,
        val data: Data,
    ) : SyncEvent {
        @Serializable
        data class Data(
            val title: String,
            val body: String,
            val sessionId: String,
            val url: String,
        )
    }

    /** The agent consumed queued user messages: stamp `invokedAt`, leave the queued bar. */
    @Serializable
    data class MessagesConsumed(
        override val namespace: String? = null,
        val sessionId: String,
        val localIds: List<String>,
        val invokedAt: Long,
    ) : SyncEvent

    @Serializable
    data class MessagesIndeterminate(
        override val namespace: String? = null,
        val sessionId: String,
        val localIds: List<String>,
    ) : SyncEvent

    @Serializable
    data class MessagesRequeued(
        override val namespace: String? = null,
        val sessionId: String,
        val localIds: List<String>,
    ) : SyncEvent

    @Serializable
    data class MessageCancelled(
        override val namespace: String? = null,
        val sessionId: String,
        val messageId: String,
        val localId: String? = null,
    ) : SyncEvent

    /** Staleness-watchdog food; carries no SSE `id`. */
    @Serializable
    data class Heartbeat(
        override val namespace: String? = null,
        val data: Data? = null,
    ) : SyncEvent {
        @Serializable
        data class Data(
            val timestamp: Long,
        )
    }

    /** Subscribe handshake; carries no SSE `id`. */
    @Serializable
    data class ConnectionChanged(
        override val namespace: String? = null,
        val data: Data? = null,
    ) : SyncEvent {
        @Serializable
        data class Data(
            val status: String,
            /** Needed for `POST /api/visibility` reporting. */
            val subscriptionId: String? = null,
            /** `'ok'` = replay is complete, skip resync; `'gap'`/absent = full REST resync. */
            val resume: String? = null,
        )
    }

    /**
     * Unrecognized `type`, or a known `type` whose payload failed to decode
     * (the web reference likewise drops frames failing `safeParse`). Callers
     * treat it as a no-op; [raw] is retained for diagnostics.
     */
    data class Unknown(
        val type: String?,
        val raw: JsonObject? = null,
    ) : SyncEvent {
        override val namespace: String? get() = raw?.get("namespace").stringOrNull
    }
}

object SyncEvents {
    /**
     * Total decode of one SSE `data:` payload. Never throws: invalid JSON,
     * non-object frames, unknown `type`s, and malformed known-type payloads
     * all become [SyncEvent.Unknown].
     */
    fun parse(json: String): SyncEvent {
        val element = try {
            HapiJson.parseToJsonElement(json)
        } catch (_: Exception) {
            return SyncEvent.Unknown(type = null, raw = null)
        }
        return parse(element)
    }

    fun parse(element: JsonElement): SyncEvent {
        val obj = element as? JsonObject ?: return SyncEvent.Unknown(type = null, raw = null)
        val type = obj["type"].stringOrNull ?: return SyncEvent.Unknown(type = null, raw = obj)
        val strategy: DeserializationStrategy<SyncEvent> = when (type) {
            "session-added" -> SyncEvent.SessionAdded.serializer()
            "session-updated" -> SyncEvent.SessionUpdated.serializer()
            "session-removed" -> SyncEvent.SessionRemoved.serializer()
            "message-received" -> SyncEvent.MessageReceived.serializer()
            "messages-invalidated" -> SyncEvent.MessagesInvalidated.serializer()
            "scheduled-matured" -> SyncEvent.ScheduledMatured.serializer()
            "session-ended" -> SyncEvent.SessionEnded.serializer()
            "machine-updated" -> return parseMachineUpdated(obj)
            "toast" -> SyncEvent.Toast.serializer()
            "messages-consumed" -> SyncEvent.MessagesConsumed.serializer()
            "messages-indeterminate" -> SyncEvent.MessagesIndeterminate.serializer()
            "messages-requeued" -> SyncEvent.MessagesRequeued.serializer()
            "message-cancelled" -> SyncEvent.MessageCancelled.serializer()
            "heartbeat" -> SyncEvent.Heartbeat.serializer()
            "connection-changed" -> SyncEvent.ConnectionChanged.serializer()
            else -> return SyncEvent.Unknown(type = type, raw = obj)
        }
        return try {
            HapiJson.decodeFromJsonElement(strategy, obj)
        } catch (_: Exception) {
            SyncEvent.Unknown(type = type, raw = obj)
        }
    }

    private fun parseMachineUpdated(obj: JsonObject): SyncEvent {
        val machineId = obj["machineId"].stringOrNull
            ?: return SyncEvent.Unknown(type = "machine-updated", raw = obj)
        return SyncEvent.MachineUpdated(
            namespace = obj["namespace"].stringOrNull,
            machineId = machineId,
            data = if (obj.containsKey("data")) {
                OptionalField.Present(obj.getValue("data"))
            } else {
                OptionalField.Absent
            },
        )
    }
}

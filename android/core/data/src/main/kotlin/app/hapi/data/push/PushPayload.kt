package app.hapi.data.push

import app.hapi.protocol.wire.HapiJson
import kotlinx.serialization.Serializable

/**
 * `data.type` of an FCM push (`docs/api/native-companion-contract.md`).
 * Unknown wire values map to a null [PushPayload.type] — the message is still
 * rendered from `title`/`body` (forward compatibility), just without
 * type-specific actions.
 */
enum class PushType(val wire: String) {
    READY("ready"),
    PERMISSION_REQUEST("permission-request"),
    TASK_NOTIFICATION("task-notification");

    companion object {
        fun fromWire(value: String): PushType? = entries.firstOrNull { it.wire == value }
    }
}

/** `data.severity` — visual urgency accent (`hub/src/fcm/fcmService.ts`). */
enum class PushSeverity(val wire: String) {
    INFO("info"),
    SUCCESS("success"),
    WARNING("warning"),
    ERROR("error");

    companion object {
        fun fromWire(value: String?): PushSeverity? =
            value?.let { wire -> entries.firstOrNull { it.wire == wire } }
    }
}

/**
 * Parsed `data.notifySummary` (JSON string, only on `ready`): the agent's
 * trailing `AGENT_NOTIFY_SUMMARY {...}` line, pre-truncated by the hub
 * (`hub/src/fcm/fcmNotificationChannel.ts`). All fields optional — the shape
 * is agent-authored.
 */
@Serializable
data class PushNotifySummary(
    val version: Int? = null,
    val summary: String? = null,
    val action: String? = null,
    val status: String? = null,
    val agent: String? = null,
    val project: String? = null,
)

/**
 * One decoded data-only FCM message from a hub. The wire contract is
 * `docs/api/native-companion-contract.md` (producer:
 * `hub/src/fcm/fcmNotificationChannel.ts`); every value arrives as a string
 * in `RemoteMessage.data`.
 *
 * Parsing is deliberately tolerant: only `sessionId` is required (it anchors
 * the notification tag and the tap-through navigation). Unknown `type`,
 * `severity`, or `contractVersion` values never drop the message — it
 * degrades to a plain title/body notification.
 */
data class PushPayload(
    /** Decoded type, or null when [rawType] is unknown to this client. */
    val type: PushType?,
    /** The wire `type` string as received (tag construction, diagnostics). */
    val rawType: String,
    val sessionId: String,
    val sessionName: String?,
    /** Hub-relative deep-link path, e.g. `/sessions/{id}` (informational). */
    val url: String?,
    val title: String?,
    val body: String?,
    /** Permission requests only: the id for approve/deny. */
    val requestId: String?,
    val severity: PushSeverity?,
    val contractVersion: String?,
    val notifySummary: PushNotifySummary?,
) {

    /**
     * False when the hub stamped a `contractVersion` this client does not
     * know. Per the contract's versioning rule, breaking changes bump the
     * version — so an unknown version renders title/body only (no actions
     * whose semantics may have changed).
     */
    val isKnownContractVersion: Boolean
        get() = contractVersion == null || contractVersion == CONTRACT_VERSION

    /**
     * Whether type-specific affordances (Allow/Deny, Reply) may be attached.
     * Requires a known contract version, a known type, and — for permission
     * requests — a `requestId` to act on.
     */
    val supportsActions: Boolean
        get() = isKnownContractVersion && when (type) {
            PushType.PERMISSION_REQUEST -> requestId != null
            PushType.READY, PushType.TASK_NOTIFICATION -> true
            null -> false
        }

    /**
     * Notification channel routing: `permission_requests` (HIGH) /
     * `ready` (DEFAULT) / `task_notifications` (DEFAULT). Unknown types and
     * unknown contract versions land in the default-importance
     * `task_notifications` bucket — never in the heads-up channel.
     */
    val channelId: String
        get() = when {
            !isKnownContractVersion -> CHANNEL_TASK_NOTIFICATIONS
            type == PushType.PERMISSION_REQUEST -> CHANNEL_PERMISSION_REQUESTS
            type == PushType.READY -> CHANNEL_READY
            else -> CHANNEL_TASK_NOTIFICATIONS
        }

    /**
     * Coalescing tag `type-<sessionId>`: a newer push of the same type for
     * the same session replaces the previous notification instead of
     * stacking (mirrors the hub-side `tag` scheme it uses for Web Push).
     */
    val notificationTag: String
        get() = "${rawType.ifBlank { "unknown" }}-$sessionId"

    /** Title to render; falls back to the session name, then a constant. */
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: sessionName?.takeIf { it.isNotBlank() }
            ?: DEFAULT_TITLE

    /**
     * Body to render. For `ready` pushes carrying a parsed [notifySummary],
     * the summary (plus a `-> action` second line, when distinct) wins over
     * the hub-composed `body` — same composition the hub itself uses, but
     * from the structured field so future client styling can diverge.
     */
    val displayBody: String
        get() {
            if (type == PushType.READY) {
                val summary = notifySummary?.summary?.takeIf { it.isNotBlank() }
                if (summary != null) {
                    val action = notifySummary.action
                        ?.takeIf { it.isNotBlank() && it != summary }
                    return if (action != null) "$summary\n-> $action" else summary
                }
            }
            return body.orEmpty()
        }

    companion object {
        /** The contract version this client implements. */
        const val CONTRACT_VERSION = "1"

        const val CHANNEL_PERMISSION_REQUESTS = "permission_requests"
        const val CHANNEL_READY = "ready"
        const val CHANNEL_TASK_NOTIFICATIONS = "task_notifications"

        private const val DEFAULT_TITLE = "HAPI"

        /**
         * Decodes `RemoteMessage.data`. Returns null only when `sessionId`
         * is missing/blank — without it neither coalescing nor tap-through
         * can work, and the contract guarantees it on every message.
         */
        fun parse(data: Map<String, String>): PushPayload? {
            val sessionId = data["sessionId"]?.takeIf { it.isNotBlank() } ?: return null
            val rawType = data["type"].orEmpty()
            return PushPayload(
                type = PushType.fromWire(rawType),
                rawType = rawType,
                sessionId = sessionId,
                sessionName = data["sessionName"]?.takeIf { it.isNotBlank() },
                url = data["url"]?.takeIf { it.isNotBlank() },
                title = data["title"],
                body = data["body"],
                requestId = data["requestId"]?.takeIf { it.isNotBlank() },
                severity = PushSeverity.fromWire(data["severity"]),
                contractVersion = data["contractVersion"]?.takeIf { it.isNotBlank() },
                notifySummary = data["notifySummary"]?.let(::parseNotifySummary),
            )
        }

        /** Malformed JSON → null (the hub-composed `body` remains the fallback). */
        private fun parseNotifySummary(raw: String): PushNotifySummary? = try {
            HapiJson.decodeFromString<PushNotifySummary>(raw)
        } catch (_: Exception) {
            null
        }
    }
}

/**
 * FCM fires unconditionally per the contract (the native app is the canonical
 * push surface). The one client-side refinement: while the app is foreground
 * **with that very session's chat open**, the in-app SSE stream is already
 * showing the event — posting an OS notification on top would just be noise.
 * Everything else (foreground on another screen, background, other sessions)
 * notifies normally.
 */
fun shouldSuppressPush(
    appForeground: Boolean,
    openChatSessionId: String?,
    payloadSessionId: String,
): Boolean = appForeground && openChatSessionId != null && openChatSessionId == payloadSessionId

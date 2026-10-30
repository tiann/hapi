package app.hapi.companion.feature.chat

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.boolOrNull
import app.hapi.protocol.wire.objOrNull
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.Json

/**
 * Pure menu state machine for the conversation-history actions (fork
 * current / fork from message / rewind) — a port of the web gating in
 * `UserMessage.tsx` / `AssistantMessage.tsx`:
 *
 * - assistant rows: fork-current only, and only on the latest completed
 *   boundary block;
 * - user rows: fork-current when the row IS the latest boundary, fork-at-
 *   message when it is an older native boundary
 *   (`conversationHistoryPoints[localId] === true`), rewind on any native
 *   boundary row;
 * - everything hides while an action is pending or the agent is running
 *   (web `actionsLocked`), for terminal-controlled sessions (web withholds
 *   the handlers), and for inactive sessions (web `ctx.disabled`).
 */

/** Which fork flavor a row offers (rewind is a plain boolean flag). */
enum class HistoryActionKind { ForkCurrent, ForkAtMessage }

/** The actions one message row may offer. */
data class MessageHistoryActions(
    val fork: HistoryActionKind? = null,
    val rewind: Boolean = false,
) {
    val isEmpty: Boolean get() = fork == null && !rewind

    companion object {
        val NONE = MessageHistoryActions()
    }
}

/**
 * Session-level inputs every row shares (computed once per pipeline run in
 * [ChatViewModel.buildUiState]). Defaults render the actions off — used by
 * non-chat hosts (inspection cards) and before the detail loads.
 */
data class ChatHistoryGate(
    val forkCurrent: Boolean = false,
    val forkAtMessage: Boolean = false,
    val rewindToMessage: Boolean = false,
    /** `metadata.conversationHistoryPoints` — per-`localId` boundary flags. */
    val historyPoints: Map<String, Boolean> = emptyMap(),
    /** Latest safe-to-fork boundary block key (`kind:id`), null when none. */
    val latestBoundaryKey: String? = null,
    /** Session active, remote-controllable, and not history-diverged. */
    val available: Boolean = false,
    /** Web `actionsLocked`: an action is pending or the agent is running. */
    val locked: Boolean = false,
) {
    val enabled: Boolean get() = available && !locked
}

/**
 * Per-row gating. [role] is the visible thread role (`visibleBlockRole`),
 * [localId] the row's wire local id (null for synthesized blocks),
 * [blockKey] the row's thread key (`VisibleChatBlock.threadKey`).
 */
fun messageHistoryActions(
    role: String,
    localId: String?,
    blockKey: String,
    gate: ChatHistoryGate,
): MessageHistoryActions {
    if (!gate.enabled) return MessageHistoryActions.NONE
    val hasNativePoint = !localId.isNullOrEmpty() && gate.historyPoints[localId] == true
    val isLatestBoundary = gate.latestBoundaryKey != null && blockKey == gate.latestBoundaryKey
    return when (role) {
        "user" -> MessageHistoryActions(
            fork = when {
                gate.forkCurrent && isLatestBoundary -> HistoryActionKind.ForkCurrent
                gate.forkAtMessage && hasNativePoint && !isLatestBoundary -> HistoryActionKind.ForkAtMessage
                else -> null
            },
            rewind = gate.rewindToMessage && hasNativePoint,
        )
        "assistant" -> MessageHistoryActions(
            fork = if (gate.forkCurrent && isLatestBoundary) HistoryActionKind.ForkCurrent else null,
            rewind = false,
        )
        else -> MessageHistoryActions.NONE
    }
}

/**
 * The only machine error code a rewind 409 carries that clients act on
 * (`RewindConversationErrorCode`): the rewind was refused because the
 * native boundary is ambiguous, but forking at the requested point is
 * known-safe — web offers a "Fork here" fallback dialog for it.
 */
const val REWIND_FALLBACK_CODE = "ambiguous_native_boundary_fork_safe"

/**
 * Human-readable history-action failure (mirror of `formatReopenError`):
 * prefer the hub's `{error}` string, fall back to the raw exception text.
 * Null lets the UI show its localized fallback.
 */
fun formatHistoryActionError(error: Exception): String? {
    val fallback = error.message
    val body = (error as? ApiError)?.body ?: return fallback
    val parsed = try {
        Json.parseToJsonElement(body).objOrNull
    } catch (_: Exception) {
        null
    } ?: return fallback
    return parsed["error"].stringOrNull ?: fallback
}

/**
 * Whether a rewind failure carries `hydrateFailed: true` — the hub could
 * not reconcile native history after truncation and marked the session
 * diverged; the rewind's outcome is unknown. Surfaced as a distinct notice
 * (web `markConversationHistoryDiverged`, HTTP 500).
 */
fun rewindHydrateFailed(error: Exception): Boolean {
    if (error !is ApiError || error.status != 500) return false
    val body = error.body ?: return false
    val parsed = try {
        Json.parseToJsonElement(body).objOrNull
    } catch (_: Exception) {
        null
    } ?: return false
    return parsed["hydrateFailed"].boolOrNull == true
}

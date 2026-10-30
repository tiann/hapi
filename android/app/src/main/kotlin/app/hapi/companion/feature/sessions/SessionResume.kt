package app.hapi.companion.feature.sessions

import app.hapi.protocol.catalog.AgentFlavor
import app.hapi.protocol.wire.SessionMetadata

/**
 * Whether the Cursor chat-store probe applies to a session — port of the web
 * hook's `shouldProbe` (`useCursorChatStoreStatus.ts`): an inactive Cursor
 * session with a resume id (`cursorSessionId`, or the summary projection's
 * `agentSessionId`) and a workspace path. Callers feed the id they have: the
 * detail metadata carries `cursorSessionId`, the list summary only the
 * hub-computed per-flavor `agentSessionId`.
 */
fun isCursorChatStoreProbeApplicable(
    active: Boolean,
    flavor: String?,
    cursorSessionId: String?,
    path: String?,
): Boolean = !active && flavor == "cursor" &&
    !cursorSessionId.isNullOrEmpty() && !path.isNullOrEmpty()

/**
 * Agent thread id used by the hub's `resolveAgentResumeId`, flavor-specific.
 * Port of `resolveAgentSessionIdFromMetadata` (`web/src/lib/sessionResume.ts`):
 * cross-flavor ids are ignored so this layer cannot claim a session is
 * resumable when the hub will only honor the current flavor's id. Unknown or
 * missing flavors resolve as claude; dsh deliberately has no resume id.
 */
fun resolveAgentSessionIdFromMetadata(metadata: SessionMetadata?): String? {
    if (metadata == null) return null
    val flavor = metadata.flavor?.takeIf(AgentFlavor.Companion::isKnown) ?: "claude"
    return when (flavor) {
        "agy" -> metadata.agySessionId
        "codex" -> metadata.codexSessionId
        "gemini" -> metadata.geminiSessionId
        "opencode" -> metadata.opencodeSessionId
        "grok" -> metadata.grokSessionId
        "cursor" -> metadata.cursorSessionId
        "kimi" -> metadata.kimiSessionId
        "copilot" -> metadata.copilotSessionId
        "pi" -> metadata.piSessionId
        "dsh" -> null
        else -> metadata.claudeSessionId
    }
}

/**
 * Whether an inactive session can be activated via resume (or fresh spawn on
 * first send) — port of `inactiveSessionCanResume` (`sessionResume.ts`),
 * matching the hub: resume with the flavor's agent id, or fresh spawn when a
 * path exists with no agent id and no user messages. Claude and Codex with
 * messages but no flavor-specific id may attempt the hub-authoritative
 * stored-message recovery path.
 *
 * Cursor: a definitive [cursorChatOnDisk] `false` still blocks. Probe failure
 * / unknown (`null`) must NOT be treated as missing data — allow reopen and
 * show honest messaging (tiann/hapi#1084).
 */
fun inactiveSessionCanResume(
    active: Boolean,
    metadata: SessionMetadata?,
    userMessageCount: Int,
    cursorChatOnDisk: Boolean? = null,
): Boolean {
    if (active) return true
    if (metadata == null || metadata.path.isEmpty()) return false
    val flavor = metadata.flavor?.takeIf(AgentFlavor.Companion::isKnown) ?: "claude"
    if (resolveAgentSessionIdFromMetadata(metadata) != null) {
        return if (flavor == "cursor") cursorChatOnDisk != false else true
    }
    if ((flavor == "claude" || flavor == "codex") && userMessageCount > 0) {
        return true
    }
    return userMessageCount == 0
}

/** UI reason a Cursor reopen affordance is disabled (`CursorReopenGateReason`). */
enum class CursorReopenGateReason {
    /** Definitive `onDisk: false` — the chat store is gone on the machine. */
    Missing,

    /** Probe in flight (or never started) — reopen stays disabled until it settles. */
    Checking,
}

/** Resolved gate for one Cursor reopen affordance (`resolveCursorReopenGate`). */
data class CursorReopenGate(
    /** null ⇒ reopen allowed; [CursorReopenGateReason.Missing]/[.Checking] ⇒ disabled with reason. */
    val disabledReason: CursorReopenGateReason?,
    /** Probe errored (old runner / offline): reopen allowed, hint that it is unverified. */
    val probeUnverified: Boolean,
)

/**
 * UI gate for Cursor reopen — port of `resolveCursorReopenGate`
 * (`sessionResume.ts`). Only a definitive `onDisk: false` disables reopen;
 * probe errors / unknown status allow the attempt (soft-fail) with the
 * unverified hint. The fall-through (applicable, no data, no error, not
 * loading — e.g. a probe that never started) is `Checking`, matching the web
 * row-menu first-frame semantics.
 */
fun resolveCursorReopenGate(
    applicable: Boolean,
    onDisk: Boolean?,
    probeFailed: Boolean,
    isLoading: Boolean,
): CursorReopenGate = when {
    !applicable -> CursorReopenGate(disabledReason = null, probeUnverified = false)
    onDisk == false -> CursorReopenGate(disabledReason = CursorReopenGateReason.Missing, probeUnverified = false)
    onDisk == true -> CursorReopenGate(disabledReason = null, probeUnverified = false)
    probeFailed -> CursorReopenGate(disabledReason = null, probeUnverified = true)
    else -> CursorReopenGate(disabledReason = CursorReopenGateReason.Checking, probeUnverified = false)
}

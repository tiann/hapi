package app.hapi.companion.feature.chat.permissions

import app.hapi.protocol.catalog.Flavors
import app.hapi.protocol.chat.ToolPermission
import app.hapi.protocol.chat.getInputStringAny
import kotlinx.serialization.json.JsonElement

/**
 * Settled-permission verdict classification, ported from
 * `web/src/components/ToolCard/PermissionFooter.tsx`
 * ([`isToolAllowedForSession`] and [`PermissionVerdicts.classify`] mirror
 * `formatPermissionSummary`). The web settled footer itself stays minimal
 * (a red reason box); Android renders the full verdict line from this
 * classifier instead — the classification, not the minimalism, is the
 * parity target. Pure JVM — unit-tested alongside the ViewModel.
 */

/** Localized label kind; the composable maps it to a string resource. */
enum class PermissionVerdictLabel {
    WAITING_FOR_APPROVAL,
    APPROVED,
    APPROVED_FOR_SESSION,
    APPROVED_ALLOW_ALL_EDITS,
    DENIED,
    ABORTED,
    CANCELED,
    RESOLVED,
    /** Web fallback `t('tool.allow')`; unreachable for known statuses. */
    ALLOW,
}

data class PermissionVerdict(
    val label: PermissionVerdictLabel,
    /** Raw wire reason; appended to the label when present. */
    val reason: String? = null,
)

object PermissionVerdicts {
    /** `PermissionFooter.isCodexSession` twin (flavor family + tool-name prefixes). */
    fun isCodexSession(flavor: String?, toolName: String): Boolean =
        Flavors.isCodexFamily(flavor) || flavor == "cursor" ||
            toolName.startsWith("Codex") || toolName.startsWith("Gemini") ||
            toolName.startsWith("OpenCode") || toolName.startsWith("Copilot") ||
            toolName.startsWith("Cursor")

    /** `isToolAllowedForSession`: plain tool-name hit or the `Bash(command)` qualifier. */
    fun isToolAllowedForSession(toolName: String, toolInput: JsonElement?, allowedTools: List<String>?): Boolean {
        if (allowedTools.isNullOrEmpty()) return false
        if (toolName in allowedTools) return true
        if (toolName == "Bash") {
            val command = getInputStringAny(toolInput, listOf("command", "cmd"))
            if (command != null) return "Bash($command)" in allowedTools
        }
        return false
    }

    /** `formatPermissionSummary` port: status/decision/mode/allowedTools → verdict. */
    fun classify(
        permission: ToolPermission,
        toolName: String,
        toolInput: JsonElement?,
        flavor: String?,
    ): PermissionVerdict {
        if (permission.status == "resolved") return PermissionVerdict(PermissionVerdictLabel.RESOLVED)
        if (permission.status == "pending") return PermissionVerdict(PermissionVerdictLabel.WAITING_FOR_APPROVAL)
        if (permission.status == "canceled") {
            return PermissionVerdict(PermissionVerdictLabel.CANCELED, permission.reason)
        }

        if (isCodexSession(flavor, toolName)) {
            if (permission.status == "approved" && permission.decision == "approved_for_session") {
                return PermissionVerdict(PermissionVerdictLabel.APPROVED_FOR_SESSION)
            }
            if (permission.status == "approved") return PermissionVerdict(PermissionVerdictLabel.APPROVED)
            if (permission.status == "denied" && permission.decision == "abort") {
                return PermissionVerdict(PermissionVerdictLabel.ABORTED, permission.reason)
            }
            if (permission.status == "denied") return PermissionVerdict(PermissionVerdictLabel.DENIED, permission.reason)
            return PermissionVerdict(PermissionVerdictLabel.ALLOW)
        }

        if (permission.status == "approved") {
            if (permission.mode == "acceptEdits") return PermissionVerdict(PermissionVerdictLabel.APPROVED_ALLOW_ALL_EDITS)
            if (permission.decision == "approved_for_session" ||
                isToolAllowedForSession(toolName, toolInput, permission.allowedTools)
            ) {
                return PermissionVerdict(PermissionVerdictLabel.APPROVED_FOR_SESSION)
            }
            return PermissionVerdict(PermissionVerdictLabel.APPROVED)
        }

        if (permission.status == "denied") return PermissionVerdict(PermissionVerdictLabel.DENIED, permission.reason)
        return PermissionVerdict(PermissionVerdictLabel.ALLOW)
    }
}

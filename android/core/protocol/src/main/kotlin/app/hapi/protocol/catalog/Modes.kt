package app.hapi.protocol.catalog

/**
 * Permission-mode / collaboration-mode catalogs — data port of
 * `shared/src/modes.ts` and `shared/src/copilotModes.ts`. Labels and tones are
 * carried verbatim from the TS source (en labels; i18n is a UI concern).
 */
enum class PermissionModeTone {
    Neutral,
    Info,
    Warning,
    Danger,
}

/**
 * All permission modes across flavors (`PERMISSION_MODES` — declaration order
 * preserved, it is the canonical listing order).
 */
enum class PermissionMode(
    val wireId: String,
    val label: String,
    val tone: PermissionModeTone,
) {
    Default("default", "Default", PermissionModeTone.Neutral),
    AcceptEdits("acceptEdits", "Accept Edits", PermissionModeTone.Warning),
    Auto("auto", "Auto", PermissionModeTone.Warning),
    BypassPermissions("bypassPermissions", "Yolo", PermissionModeTone.Danger),
    Plan("plan", "Plan Mode", PermissionModeTone.Info),
    Ask("ask", "Ask Mode", PermissionModeTone.Info),
    Debug("debug", "Debug Mode", PermissionModeTone.Info),
    AutoReview("autoReview", "Auto-review", PermissionModeTone.Warning),
    ReadOnly("read-only", "Read Only", PermissionModeTone.Warning),
    SafeYolo("safe-yolo", "Safe Yolo", PermissionModeTone.Warning),
    Yolo("yolo", "Yolo", PermissionModeTone.Danger),
    RequestReview("request-review", "Request Review", PermissionModeTone.Neutral),
    AlwaysProceed("always-proceed", "Always Proceed", PermissionModeTone.Danger),
    ;

    companion object {
        private val BY_WIRE_ID: Map<String, PermissionMode> = entries.associateBy { it.wireId }

        /** Resolve a wire string; unknown → null (render raw, offer no switch). */
        fun fromWireId(raw: String?): PermissionMode? = raw?.let(BY_WIRE_ID::get)
    }
}

object PermissionModes {
    /** `AGY_PERMISSION_MODES`. */
    val AGY = listOf(PermissionMode.RequestReview, PermissionMode.AlwaysProceed)

    /** `CLAUDE_PERMISSION_MODES`. */
    val CLAUDE = listOf(
        PermissionMode.Default, PermissionMode.AcceptEdits, PermissionMode.Auto,
        PermissionMode.BypassPermissions, PermissionMode.Plan,
    )

    /** `CODEX_PERMISSION_MODES` (gemini/kimi/copilot share the same list). */
    val CODEX = listOf(
        PermissionMode.Default, PermissionMode.ReadOnly,
        PermissionMode.SafeYolo, PermissionMode.Yolo,
    )

    /** `GROK_PERMISSION_MODES`. */
    val GROK = listOf(
        PermissionMode.Default, PermissionMode.Auto,
        PermissionMode.Plan, PermissionMode.BypassPermissions,
    )

    /** `OPENCODE_PERMISSION_MODES`. */
    val OPENCODE = listOf(PermissionMode.Default, PermissionMode.Plan, PermissionMode.Yolo)

    /** `CURSOR_PERMISSION_MODES`. */
    val CURSOR = listOf(
        PermissionMode.Default, PermissionMode.Plan, PermissionMode.Ask,
        PermissionMode.Debug, PermissionMode.AutoReview, PermissionMode.Yolo,
    )

    /**
     * `getPermissionModesForFlavor`: branch-for-branch port. Pi has no runtime
     * permission switching (always auto-approve) → empty; `null`/unknown
     * flavors fall back to the Claude list, exactly like the TS.
     */
    fun forFlavor(flavor: String?): List<PermissionMode> = when (flavor) {
        "codex" -> CODEX
        "gemini" -> CODEX
        "kimi" -> CODEX
        "copilot" -> CODEX
        "grok" -> GROK
        "opencode" -> OPENCODE
        "dsh" -> emptyList()
        "agy" -> AGY
        "cursor" -> CURSOR
        "pi" -> emptyList()
        else -> CLAUDE
    }

    /** `isPermissionModeAllowedForFlavor`. */
    fun isAllowedForFlavor(mode: PermissionMode, flavor: String?): Boolean =
        mode in forFlavor(flavor)
}

/** `CODEX_COLLABORATION_MODES` + labels. */
enum class CodexCollaborationMode(val wireId: String, val label: String) {
    Default("default", "Default"),
    Plan("plan", "Plan"),
    ;

    companion object {
        private val BY_WIRE_ID: Map<String, CodexCollaborationMode> = entries.associateBy { it.wireId }

        fun fromWireId(raw: String?): CodexCollaborationMode? = raw?.let(BY_WIRE_ID::get)
    }
}

/** `COPILOT_AGENT_MODES` + labels (`shared/src/copilotModes.ts`). */
enum class CopilotAgentMode(val wireId: String, val label: String) {
    Interactive("interactive", "Interactive"),
    Plan("plan", "Plan"),
    Autopilot("autopilot", "Autopilot"),
    ;

    companion object {
        private val BY_WIRE_ID: Map<String, CopilotAgentMode> = entries.associateBy { it.wireId }

        fun fromWireId(raw: String?): CopilotAgentMode? = raw?.let(BY_WIRE_ID::get)

        /**
         * `normalizeCopilotAgentMode`: legacy `'fleet'` (briefly a peer mode;
         * really the `/fleet` slash command) and any invalid value coerce to
         * [Interactive].
         */
        fun normalize(raw: String?): CopilotAgentMode = fromWireId(raw) ?: Interactive
    }
}

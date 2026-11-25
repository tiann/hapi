package app.hapi.protocol.catalog

/**
 * Agent flavor catalog — port of `shared/src/modes.ts` (`AGENT_FLAVORS`) and
 * `shared/src/flavors.ts` (capabilities/labels). Wire models keep flavor as a
 * raw string; resolve it here. Unknown strings map to [AgentFlavor.Other] so
 * sessions from a newer hub stay renderable.
 */
sealed interface AgentFlavor {
    /** Wire id (`metadata.flavor`). */
    val id: String

    data object Agy : AgentFlavor { override val id = "agy" }
    data object Claude : AgentFlavor { override val id = "claude" }
    data object Codex : AgentFlavor { override val id = "codex" }
    data object Dsh : AgentFlavor { override val id = "dsh" }
    data object Copilot : AgentFlavor { override val id = "copilot" }
    data object Cursor : AgentFlavor { override val id = "cursor" }
    data object Gemini : AgentFlavor { override val id = "gemini" }
    data object Grok : AgentFlavor { override val id = "grok" }
    data object Kimi : AgentFlavor { override val id = "kimi" }
    data object Opencode : AgentFlavor { override val id = "opencode" }
    data object Pi : AgentFlavor { override val id = "pi" }

    /** A flavor this client build does not know. */
    data class Other(val raw: String) : AgentFlavor {
        override val id: String get() = raw
    }

    companion object {
        /** `AGENT_FLAVORS` — declaration order preserved. */
        val KNOWN: List<AgentFlavor> = listOf(
            Agy, Claude, Codex, Dsh, Copilot, Cursor, Gemini, Grok, Kimi, Opencode, Pi,
        )

        /**
         * `CREATABLE_AGENT_FLAVORS`: flavors offered when creating a session.
         * Gemini is excluded (consumer Gemini CLI sunset 2026-06-18) but stays
         * in [KNOWN] so stored sessions remain viewable.
         */
        val CREATABLE: List<AgentFlavor> = KNOWN.filter { it != Gemini }

        private val BY_ID: Map<String, AgentFlavor> = KNOWN.associateBy { it.id }

        /** Resolve a wire flavor string; `null`/blank stays `null`, unknown → [Other]. */
        fun from(raw: String?): AgentFlavor? {
            if (raw == null) return null
            return BY_ID[raw] ?: Other(raw)
        }

        /** `isKnownFlavor` (`shared/src/flavors.ts`). */
        fun isKnown(raw: String?): Boolean = raw != null && raw in BY_ID
    }
}

/** Capability ids (`Capabilities` in `shared/src/flavors.ts`). */
enum class FlavorCapability {
    ModelChange,
    Effort,
}

object Flavors {
    private val CAPS: Map<String, Set<FlavorCapability>> = mapOf(
        "agy" to setOf(FlavorCapability.ModelChange),
        "claude" to setOf(FlavorCapability.ModelChange, FlavorCapability.Effort),
        "gemini" to setOf(FlavorCapability.ModelChange),
        "kimi" to setOf(FlavorCapability.ModelChange),
        "copilot" to setOf(FlavorCapability.ModelChange),
        "grok" to setOf(FlavorCapability.ModelChange, FlavorCapability.Effort),
        "codex" to setOf(FlavorCapability.ModelChange),
        "dsh" to emptySet(),
        "cursor" to setOf(FlavorCapability.ModelChange),
        "opencode" to setOf(FlavorCapability.ModelChange),
        "pi" to setOf(FlavorCapability.ModelChange, FlavorCapability.Effort),
    )

    private val LABELS: Map<String, String> = mapOf(
        "agy" to "Antigravity",
        "claude" to "Claude",
        "gemini" to "Gemini",
        "kimi" to "Kimi",
        "copilot" to "Copilot",
        "grok" to "Grok Build",
        "codex" to "Codex",
        "dsh" to "DeepSeek Harness",
        "cursor" to "Cursor",
        "opencode" to "OpenCode",
        "pi" to "Pi",
    )

    fun hasCapability(flavor: String?, capability: FlavorCapability): Boolean =
        CAPS[flavor]?.contains(capability) == true

    /** `getFlavorLabel`: unknown → `"Unknown"`. */
    fun label(flavor: String?): String = LABELS[flavor] ?: "Unknown"

    fun supportsModelChange(flavor: String?): Boolean =
        hasCapability(flavor, FlavorCapability.ModelChange)

    fun supportsEffort(flavor: String?): Boolean =
        hasCapability(flavor, FlavorCapability.Effort)

    /** `isCodexFamilyFlavor`: flavors sharing the codex-style generic envelope UX. */
    fun isCodexFamily(flavor: String?): Boolean =
        flavor == "codex" || flavor == "gemini" || flavor == "grok"
            || flavor == "kimi" || flavor == "copilot" || flavor == "opencode"
}

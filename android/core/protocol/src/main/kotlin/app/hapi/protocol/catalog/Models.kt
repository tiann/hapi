package app.hapi.protocol.catalog

/**
 * Static model / effort catalogs — data port of `shared/src/models.ts`
 * (`CLAUDE_MODEL_LABELS`) and `shared/src/effort.ts` (`CLAUDE_EFFORT_LABELS`),
 * plus the composer option-list builders from
 * `web/src/components/AssistantChat/claudeModelOptions.ts` /
 * `claudeEffortOptions.ts`. Codex-family model lists are NOT static — they
 * come from `GET /api/sessions/:id/codex-models` per session.
 */
object ClaudeModels {
    /**
     * Families the catalog reports as supporting no `--effort` at all, ported
     * from `CLAUDE_MODEL_FALLBACK_OPTIONS`' `supportedEffortLevels` in
     * `shared/src/models.ts`. Anything absent here is treated as supporting the
     * full level set, which is also what an unknown or Default selection gets:
     * nothing has said otherwise.
     */
    private val EFFORTLESS_FAMILIES: Set<String> = setOf("haiku")

    /**
     * Whether `--effort` means anything for this model. `[1m]` is stripped
     * because a suffixed id names the same family as its bare counterpart.
     */
    fun supportsEffort(model: String?): Boolean {
        val resolved = family(model) ?: return true
        return resolved !in EFFORTLESS_FAMILIES
    }

    /**
     * Family behind an identifier, in whatever form it arrives: a preset, a
     * legacy `[1m]` alias, or a resolved SDK id such as
     * `claude-haiku-4-5-20251001`. Mirrors `resolveClaudeModelFamily` in
     * `shared/src/models.ts` — resolved ids are `claude-<family>-...`, so the
     * family is read structurally rather than from an id-by-id table. Null for
     * the Default sentinel and for anything unrecognized.
     */
    fun family(model: String?): String? {
        val trimmed = model?.trim()?.lowercase().orEmpty()
        if (trimmed.isEmpty() || trimmed == "auto" || trimmed == "default") return null
        val bare = if (trimmed.endsWith("[1m]")) trimmed.removeSuffix("[1m]") else trimmed
        if (LABELS.containsKey(bare)) return bare
        if (!bare.contains("claude")) return null
        // Scan for a segment naming a known family rather than taking a fixed
        // position: ids from before Claude 4 are `claude-<generation>-<family>-...`
        // so a positional read returns the generation and conflates every model
        // of it. Scanning also tolerates a vendor prefix such as `us.anthropic.`.
        val families = LABELS.keys.map { it.removeSuffix("[1m]") }.toSet()
        return bare.split('-', '.').firstOrNull { it in families }
    }

    /** `CLAUDE_MODEL_LABELS`: recognition aliases, wider than the offer list. */
    val LABELS: Map<String, String> = linkedMapOf(
        "sonnet" to "Sonnet",
        "sonnet[1m]" to "Sonnet 1M",
        "opus" to "Opus",
        "opus[1m]" to "Opus 1M",
        "fable" to "Fable",
        "fable[1m]" to "Fable 1M",
        "haiku" to "Haiku",
    )

    /**
     * `CLAUDE_MODEL_FALLBACK_OPTIONS`: what the picker offers when the live
     * catalog is unavailable: one row per family, in catalog order. The `[1m]`
     * ids are absent on purpose: they are the same models as their bare
     * counterparts, so they survive only in [LABELS], which keeps resolving
     * them for sessions created before they were dropped.
     *
     * Haiku is absent for a different reason: it is the first Claude model that
     * supports no effort at all, and these pickers post model and effort
     * separately against a static effort list, so offering it here would let a
     * native session sit on Haiku with `high` pinned. [LABELS] still resolves
     * it, so a session already on Haiku renders correctly. Add it once the
     * native effort offers are model-aware.
     */
    val FALLBACK_PRESETS: List<String> = listOf("opus", "fable", "sonnet")

    /** `getClaudeModelLabel`: trimmed lookup; unknown/blank → null. */
    fun label(model: String?): String? {
        val trimmed = model?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        return LABELS[trimmed]
    }
}

object ClaudeEfforts {
    /** `CLAUDE_EFFORT_LABELS` — ascending order preserved. */
    val LABELS: Map<String, String> = linkedMapOf(
        "low" to "Low",
        "medium" to "Medium",
        "high" to "High",
        "xhigh" to "XHigh",
        "max" to "Max",
    )

    /** `CLAUDE_EFFORT_LEVELS`. */
    val LEVELS: List<String> = LABELS.keys.toList()
}

/**
 * One picker row: `value == null` means "clear back to the agent default"
 * (wire `model: null` / `effort: null`).
 */
data class CatalogOption(
    val value: String?,
    val label: String,
)

object ModelCatalog {
    /**
     * `normalizeClaudeComposerModel`: `auto`/`default`/blank collapse to null
     * (the Default row).
     */
    fun normalizeClaudeModel(model: String?): String? {
        val trimmed = model?.trim()
        if (trimmed.isNullOrEmpty() || trimmed == "auto" || trimmed == "default") return null
        return trimmed
    }

    /**
     * `getClaudeComposerModelOptions`: Default first, then a synthetic row for
     * a current model outside the offer list, then the offer rows.
     */
    fun claudeModelOptions(currentModel: String?): List<CatalogOption> {
        val normalized = normalizeClaudeModel(currentModel)
        val options = mutableListOf(CatalogOption(value = null, label = "Default"))
        if (normalized != null && normalized !in ClaudeModels.FALLBACK_PRESETS) {
            options += CatalogOption(normalized, ClaudeModels.label(normalized) ?: normalized)
        }
        ClaudeModels.FALLBACK_PRESETS.forEach { preset ->
            options += CatalogOption(preset, ClaudeModels.label(preset) ?: preset)
        }
        return options
    }

    /** `normalizeClaudeComposerEffort`: lowercased; `auto`/`default`/blank → null. */
    fun normalizeClaudeEffort(effort: String?): String? {
        val trimmed = effort?.trim()?.lowercase()
        if (trimmed.isNullOrEmpty() || trimmed == "auto" || trimmed == "default") return null
        return trimmed
    }

    /** `getClaudeComposerEffortOptions`: Auto first, synthetic current, then levels. */
    fun claudeEffortOptions(currentEffort: String?, model: String? = null): List<CatalogOption> {
        // A model that supports no effort offers Auto only, the same shape the
        // web composer renders for it. Without this a session switched to Haiku
        // elsewhere could be pinned back to `high` from here.
        if (!ClaudeModels.supportsEffort(model)) {
            return listOf(CatalogOption(value = null, label = "Auto"))
        }
        val normalized = normalizeClaudeEffort(currentEffort)
        val options = mutableListOf(CatalogOption(value = null, label = "Auto"))
        if (normalized != null && normalized !in ClaudeEfforts.LEVELS) {
            options += CatalogOption(
                normalized,
                ClaudeEfforts.LABELS[normalized]
                    ?: normalized.replaceFirstChar { it.uppercaseChar() },
            )
        }
        ClaudeEfforts.LEVELS.forEach { level ->
            options += CatalogOption(level, ClaudeEfforts.LABELS.getValue(level))
        }
        return options
    }
}

package app.hapi.companion.feature.newsession

/** A `(wire value, display label)` pair for the option pickers. */
data class OptionItem(val value: String, val label: String)

/**
 * Static option catalogs for the create form — data ports of
 * `shared/src/models.ts` (`CLAUDE_MODEL_LABELS`), `shared/src/effort.ts`
 * (`CLAUDE_EFFORT_LABELS`) and the web `CODEX_REASONING_EFFORT_OPTIONS`
 * (`web/src/components/NewSession/types.ts`). Kept in the feature (not
 * `:core:protocol`'s catalog package) because they are create-form option
 * lists, not wire-format contracts.
 */
object NewSessionCatalogs {

    /** `'auto'` sentinel rows use the web's "Default" label. */
    val CLAUDE_MODELS: List<OptionItem> = listOf(
        OptionItem("auto", "Default"),
        OptionItem("sonnet", "Sonnet"),
        OptionItem("sonnet[1m]", "Sonnet 1M"),
        OptionItem("opus", "Opus"),
        OptionItem("opus[1m]", "Opus 1M"),
        OptionItem("fable", "Fable"),
        OptionItem("fable[1m]", "Fable 1M"),
    )

    val CLAUDE_EFFORTS: List<OptionItem> = listOf(
        OptionItem("auto", "Auto"),
        OptionItem("low", "Low"),
        OptionItem("medium", "Medium"),
        OptionItem("high", "High"),
        OptionItem("xhigh", "XHigh"),
        OptionItem("max", "Max"),
    )

    /** Static codex fallback when the model row advertises no efforts (web drops `max` for codex). */
    val CODEX_REASONING_EFFORTS: List<OptionItem> = listOf(
        OptionItem("default", "Default"),
        OptionItem("low", "Low"),
        OptionItem("medium", "Medium"),
        OptionItem("high", "High"),
        OptionItem("xhigh", "XHigh"),
    )

    /** Capitalized label for a server-advertised effort id (`high` → `High`). */
    fun effortLabel(value: String): String =
        value.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
}

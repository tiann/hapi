package app.hapi.companion.feature.chat

import app.hapi.companion.feature.newsession.CursorModels
import app.hapi.companion.feature.newsession.FlavorModelOptions
import app.hapi.protocol.catalog.CatalogOption
import app.hapi.protocol.wire.CodexModelSummary
import app.hapi.protocol.wire.GrokReasoningEffortOption
import app.hapi.protocol.wire.OpencodeReasoningEffortOption
import app.hapi.protocol.wire.PiModelSummary
import app.hapi.protocol.wire.PiSelectedModelRef

/**
 * Pure per-flavor section logic for the session config sheet (slice C) —
 * ports of `web/src/components/AssistantChat/codexFastMode.ts`,
 * `codexReasoningEffortOptions.ts`, the Pi/grok option branches of
 * `HappyComposer.tsx` + `SessionChat.tsx`, and the cursor variant rows of
 * `cursorModelOptions.ts` / `sessionChatCursorModel.ts`. No state, no
 * Android imports — the flavor→section decision table is unit-testable
 * from JVM.
 *
 * Section visibility (web truth, composer gating):
 * - claude: effort presets (already in [ModelCatalog]);
 * - codex: reasoning effort (dynamic when the model advertises efforts,
 *   presets otherwise) + fast mode (service tier) when the active model
 *   advertises a fast tier;
 * - opencode: reasoning effort only while the dynamic RPC list is non-empty;
 * - grok: effort only while the dynamic RPC list is non-empty;
 * - pi: thinking levels only while the selected model is resolved and
 *   `reasoning != false`;
 * - cursor: variant rows (exact wire ids) while the current base has >1
 *   variants.
 */
object SessionConfigSections {

    // -------------------------------------------------------- fast mode --

    private val FAST_TIER_ID = Regex("fast", RegexOption.IGNORE_CASE)

    /** `isFastTierId` — tier ids containing `fast` (case-insensitive). */
    private fun isFastTierId(tierId: String): Boolean = FAST_TIER_ID.containsMatchIn(tierId.trim())

    /**
     * `findActiveModel` — the session's catalog row: exact id match, else the
     * default row; a null/blank session model means "auto" (default active).
     */
    fun activeCodexModel(sessionModel: String?, models: List<CodexModelSummary>): CodexModelSummary? {
        val normalized = sessionModel?.trim()?.lowercase()
        if (!normalized.isNullOrEmpty()) {
            return models.firstOrNull { it.id.trim().lowercase() == normalized }
        }
        return models.firstOrNull { it.isDefault }
    }

    /**
     * `codexModelAdvertisesFastTier` — false on an empty/unloaded catalog so
     * the section stays hidden until there is an authoritative answer.
     */
    fun advertisesFastTier(sessionModel: String?, models: List<CodexModelSummary>?): Boolean {
        if (models.isNullOrEmpty()) return false
        val active = activeCodexModel(sessionModel, models) ?: return false
        return active.serviceTiers.orEmpty().any(::isFastTierId)
    }

    /** `isFastServiceTier` — `/^(fast|priority)$/i`. */
    fun isFastServiceTier(serviceTier: String?): Boolean =
        Regex("^(fast|priority)$", RegexOption.IGNORE_CASE).matches(serviceTier?.trim() ?: "")

    /**
     * `getDisplayedCodexServiceTier` — a persisted null tier (no override)
     * still needs a visible selection: render it as `standard` without
     * changing what a future post sends.
     */
    fun displayedServiceTier(serviceTier: String?): String = if (isFastServiceTier(serviceTier)) "fast" else "standard"

    // --------------------------------------------------- reasoning effort --

    private val CODEX_EFFORT_PRESETS = listOf("low", "medium", "high", "xhigh")
    private val CODEX_EFFORT_LABELS = mapOf(
        "low" to "Low",
        "medium" to "Medium",
        "high" to "High",
        "xhigh" to "XHigh",
        "max" to "Max",
        "ultra" to "Ultra",
    )

    /** `normalizeCodexComposerReasoningEffort` — blank/`default` → null. */
    fun normalizeCodexReasoningEffort(effort: String?): String? {
        val trimmed = effort?.trim()?.lowercase()
        if (trimmed.isNullOrEmpty() || trimmed == "default") return null
        return trimmed
    }

    private fun effortLabel(effort: String): String =
        CODEX_EFFORT_LABELS[effort] ?: effort.replaceFirstChar { it.uppercaseChar() }

    /**
     * `getCodexModelReasoningEfforts` — the active model's (selection, else
     * default, else first row) supported efforts, normalized; null when the
     * catalog is empty or the row advertises none.
     */
    fun codexModelReasoningEfforts(models: List<CodexModelSummary>, model: String?): List<String>? {
        val normalizedModelId = model?.trim()
        val resolved = if (normalizedModelId.isNullOrEmpty() || normalizedModelId == "auto") {
            models.firstOrNull { it.isDefault } ?: models.firstOrNull()
        } else {
            models.firstOrNull { it.id == normalizedModelId }
        }
        val efforts = resolved?.supportedReasoningEfforts ?: return null
        val normalized = efforts.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.distinct()
        return normalized.ifEmpty { null }
    }

    /**
     * `buildDynamicReasoningEffortOptions` — Default first, the current effort
     * injected when it is not among the dynamic values, then the rows.
     */
    fun dynamicReasoningEffortOptions(
        currentEffort: String?,
        dynamic: List<OpencodeReasoningEffortOption>,
    ): List<CatalogOption> {
        val normalizedCurrent = normalizeCodexReasoningEffort(currentEffort)
        val options = mutableListOf(CatalogOption(value = null, label = "Default"))
        if (normalizedCurrent != null && dynamic.none { it.value == normalizedCurrent }) {
            options += CatalogOption(normalizedCurrent, effortLabel(normalizedCurrent))
        }
        dynamic.forEach { row ->
            options += CatalogOption(row.value, row.name?.takeIf { it.isNotBlank() } ?: effortLabel(row.value))
        }
        return options
    }

    /**
     * Codex rows (`getCodexComposerReasoningEffortOptions`, flavor `codex`):
     * dynamic values when the active model advertises any, else the
     * `low/medium/high/xhigh` presets with an out-of-list current injected.
     */
    fun codexReasoningEffortOptions(currentEffort: String?, dynamicEfforts: List<String>?): List<CatalogOption> {
        if (!dynamicEfforts.isNullOrEmpty()) {
            return dynamicReasoningEffortOptions(currentEffort, dynamicEfforts.map { OpencodeReasoningEffortOption(it) })
        }
        val normalizedCurrent = normalizeCodexReasoningEffort(currentEffort)
        val options = mutableListOf(CatalogOption(value = null, label = "Default"))
        if (normalizedCurrent != null && normalizedCurrent !in CODEX_EFFORT_PRESETS) {
            options += CatalogOption(normalizedCurrent, effortLabel(normalizedCurrent))
        }
        CODEX_EFFORT_PRESETS.forEach { preset ->
            options += CatalogOption(preset, CODEX_EFFORT_LABELS.getValue(preset))
        }
        return options
    }

    /**
     * Opencode rows — hidden entirely (null) while there are no dynamic
     * options; the static create-form fallback never applies to a live
     * session (web returns `[]` and withholds the handler).
     */
    fun opencodeReasoningEffortOptions(
        currentEffort: String?,
        dynamic: List<OpencodeReasoningEffortOption>?,
    ): List<CatalogOption>? =
        if (dynamic.isNullOrEmpty()) null else dynamicReasoningEffortOptions(currentEffort, dynamic)

    /**
     * Grok rows — `Default` (null) first, then the RPC options; hidden (null)
     * while the list is empty (the session sheet has no static fallback, and
     * no current-injection: unknown values simply render unselected).
     */
    fun grokReasoningEffortOptions(options: List<GrokReasoningEffortOption>?): List<CatalogOption>? {
        if (options.isNullOrEmpty()) return null
        return listOf(CatalogOption(value = null, label = "Default")) +
            options.map { CatalogOption(it.value, it.name?.takeIf { name -> name.isNotBlank() } ?: it.value) }
    }

    // -------------------------------------------------------- pi thinking --

    /**
     * `selectedPiModel` memo — the provider-qualified ref
     * (`metadata.piSelectedModel`) wins over the bare modelId: two providers
     * may share a modelId and the wrong row would send the wrong provider.
     */
    fun piSelectedModel(models: List<PiModelSummary>, model: String?, ref: PiSelectedModelRef?): PiModelSummary? {
        if (ref != null) return models.firstOrNull { it.provider == ref.provider && it.modelId == ref.modelId }
        return model?.let { selected -> models.firstOrNull { it.modelId == selected } }
    }

    /**
     * Pi thinking rows — the shared level filter; hidden (null) while the
     * selected model is unresolved (catalog loading/failed) or explicitly
     * `reasoning == false`.
     */
    fun piThinkingOptions(effort: String?, selected: PiModelSummary?): List<CatalogOption>? {
        if (selected == null || selected.reasoning == false) return null
        return FlavorModelOptions.piThinkingLevelOptions(effort, selected.thinkingLevelMap)
            .map { CatalogOption(it.value, it.label) }
    }

    // ------------------------------------------------------- cursor variant --

    /**
     * Variant rows for the session sheet — the current base's variants with
     * the base default pinned first (`buildCursorEffortPickerOptionsWithDefaultFirst`).
     * Null hides the section (no picker, flat mode, or single-variant base).
     */
    fun cursorVariantOptions(picker: CursorModels.PickerState?): List<CatalogOption>? {
        if (picker == null || !picker.showVariantPicker) return null
        return CursorModels.variantOptionsDefaultFirst(picker.baseKey, picker.catalog)
            .map { CatalogOption(it.value, it.label) }
    }

    /**
     * `resolveSessionCursorVariantSelectValue` — highlight the exact wire, or
     * the best-matching CLI sku when the hub still stores the ACP wire.
     */
    fun cursorVariantSelected(model: String?, options: List<CatalogOption>): String? {
        if (model == null || options.isEmpty()) return null
        val trimmed = model.trim()
        options.firstOrNull { it.value == trimmed }?.let { return it.value }
        if (trimmed.contains('[')) {
            return CursorModels.findBestCliSkuForAcpWire(trimmed, options.mapNotNull { it.value })
        }
        return null
    }
}

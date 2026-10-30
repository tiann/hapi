package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.CopilotModelSummary
import app.hapi.protocol.wire.GrokModelSummary
import app.hapi.protocol.wire.KimiModelSummary
import app.hapi.protocol.wire.PiModelSummary

/**
 * Pure per-flavor model/effort option builders for the create form — ports of
 * `web/src/components/NewSession/grokModels.ts`, the copilot/kimi/pi option
 * memos in `web/src/components/NewSession/index.tsx`,
 * `web/src/components/AssistantChat/piThinkingLevelOptions.ts`
 * (`shared/src/piThinkingLevel.ts`) and the agy label table
 * (`shared/src/models.ts` `AGY_MODEL_LABELS`). No state, no Android imports —
 * unit-testable from JVM.
 */
object FlavorModelOptions {

    // ------------------------------------------------------------------ agy --

    /** `AGY_MODEL_LABELS` (`shared/src/models.ts`); order = `AGY_MODEL_PRESETS`. */
    val AGY_MODEL_LABELS: Map<String, String> = linkedMapOf(
        "gemini-3.7-flash-high" to "Gemini 3.7 Flash (High)",
        "gemini-3.7-flash-medium" to "Gemini 3.7 Flash (Medium)",
        "gemini-3.7-flash-low" to "Gemini 3.7 Flash (Low)",
        "gemini-3.6-flash-high" to "Gemini 3.6 Flash (High)",
        "gemini-3.6-flash-medium" to "Gemini 3.6 Flash (Medium)",
        "gemini-3.6-flash-low" to "Gemini 3.6 Flash (Low)",
        "gemini-3.5-flash-medium" to "Gemini 3.5 Flash (Medium)",
        "gemini-3.5-flash-high" to "Gemini 3.5 Flash (High)",
        "gemini-3.5-flash-low" to "Gemini 3.5 Flash (Low)",
        "gemini-3.1-pro-low" to "Gemini 3.1 Pro (Low)",
        "gemini-3.1-pro-high" to "Gemini 3.1 Pro (High)",
        "claude-sonnet-4-6" to "Claude Sonnet 4.6 (Thinking)",
        "claude-opus-4-6-thinking" to "Claude Opus 4.6 (Thinking)",
        "gpt-oss-120b-medium" to "GPT-OSS 120B (Medium)",
    )

    /** `getAgyModelLabel` — human label for a known agy id, else null. */
    fun agyModelLabel(model: String): String? {
        val trimmed = model.trim()
        return if (trimmed.isEmpty()) null else AGY_MODEL_LABELS[trimmed]
    }

    // ----------------------------------------------------------------- grok --

    /** `GROK_EFFORT_OPTIONS` — static fallback before/without a catalog. */
    val GROK_EFFORTS: List<OptionItem> = listOf(
        OptionItem("auto", "Default"),
        OptionItem("low", "Low"),
        OptionItem("medium", "Medium"),
        OptionItem("high", "High"),
    )

    /** `buildGrokModelOptions` — Default row plus one row per discovered model. */
    fun grokModelOptions(models: List<GrokModelSummary>): List<OptionItem> =
        listOf(OptionItem("auto", "Default")) + models.map { OptionItem(it.modelId, it.name ?: it.modelId) }

    /**
     * `buildGrokEffortOptions` — efforts of the effective model (the selection,
     * or the machine's current model when Default). Models without advertised
     * efforts fall back to the static list.
     */
    fun grokEffortOptions(
        models: List<GrokModelSummary>,
        selectedModel: String,
        currentModelId: String?,
    ): List<OptionItem> {
        val effectiveModel = if (selectedModel == "auto") currentModelId else selectedModel
        val efforts = models.firstOrNull { it.modelId == effectiveModel }?.reasoningEfforts
        if (efforts.isNullOrEmpty()) {
            return GROK_EFFORTS
        }
        return listOf(OptionItem("auto", "Default")) +
            efforts.map { OptionItem(it.value, it.name ?: it.value) }
    }

    // --------------------------------------------------------------- copilot --

    /**
     * Copilot options (`index.tsx` memo): the sentinel `auto` row is labeled
     * "Auto" (not "Default") and any duplicate `auto` catalog row is dropped.
     */
    fun copilotModelOptions(models: List<CopilotModelSummary>): List<OptionItem> =
        listOf(OptionItem("auto", "Auto")) +
            models.filter { it.modelId != "auto" }
                .map { OptionItem(it.modelId, it.name ?: it.modelId) }

    // ------------------------------------------------------------------ kimi --

    /** `buildKimiModelOptions` — labels make the provider recognizable ("TheHive — GLM-5.3-flash"). */
    fun kimiModelOptions(models: List<KimiModelSummary>): List<OptionItem> =
        listOf(OptionItem("auto", "Default")) +
            models.map { model ->
                val label = if (model.provider != null) {
                    "${model.provider} — ${model.name ?: model.modelId}"
                } else {
                    model.name ?: model.modelId
                }
                OptionItem(model.modelId, label)
            }

    // ------------------------------------------------------------------- pi --

    /** `PI_THINKING_LEVELS` (`shared/src/piThinkingLevel.ts`). */
    val PI_THINKING_LEVELS: List<String> = listOf(
        "off", "minimal", "low", "medium", "high", "xhigh", "max",
    )

    private val PI_THINKING_LEVEL_LABELS: Map<String, String> = mapOf(
        "off" to "Off",
        "minimal" to "Minimal",
        "low" to "Low",
        "medium" to "Medium",
        "high" to "High",
        "xhigh" to "XHigh",
        "max" to "Max",
    )

    /**
     * `isThinkingLevelSupported` — a level mapped to null in the model's
     * thinkingLevelMap is unsupported; `xhigh`/`max` additionally require an
     * explicit non-null map entry.
     */
    fun isThinkingLevelSupported(level: String, map: Map<String, String?>?): Boolean {
        if (level == "xhigh" || level == "max") {
            if (map == null || !map.containsKey(level)) return false
            return map[level] != null
        }
        if (map == null || !map.containsKey(level)) return true
        return map[level] != null
    }

    /** `normalizePiThinkingLevel` — empty/default/auto mean "let Pi decide" (null). */
    fun normalizePiThinkingLevel(level: String?): String? {
        val trimmed = level?.trim()?.lowercase() ?: return null
        if (trimmed.isEmpty() || trimmed == "default" || trimmed == "auto") return null
        return trimmed
    }

    private fun piThinkingLevelLabel(level: String): String =
        PI_THINKING_LEVEL_LABELS[level]
            ?: level.replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }

    /**
     * `getPiThinkingLevelOptions` — standard levels filtered by the model's
     * thinkingLevelMap, with a non-standard current level kept selectable first.
     */
    fun piThinkingLevelOptions(
        currentLevel: String?,
        thinkingLevelMap: Map<String, String?>?,
    ): List<OptionItem> {
        val normalizedCurrent = normalizePiThinkingLevel(currentLevel)
        val options = mutableListOf<OptionItem>()
        if (
            normalizedCurrent != null &&
            normalizedCurrent !in PI_THINKING_LEVELS &&
            isThinkingLevelSupported(normalizedCurrent, thinkingLevelMap)
        ) {
            options.add(OptionItem(normalizedCurrent, piThinkingLevelLabel(normalizedCurrent)))
        }
        options += PI_THINKING_LEVELS
            .filter { isThinkingLevelSupported(it, thinkingLevelMap) }
            .map { OptionItem(it, PI_THINKING_LEVEL_LABELS.getValue(it)) }
        return options
    }

    /**
     * Pi options (`index.tsx` memo): values are provider-qualified
     * (`provider/modelId`) so two providers sharing a modelId stay distinct.
     * Web groups rows under provider optgroups; the dropdown flattens them.
     */
    fun piModelOptions(models: List<PiModelSummary>): List<OptionItem> =
        listOf(OptionItem("auto", "Default")) +
            models.map { model ->
                OptionItem(
                    "${model.provider.ifEmpty { "unknown" }}/${model.modelId}",
                    model.name ?: model.modelId,
                )
            }

    /**
     * Resolve the form's pi selection (`auto`, `provider/modelId` or a bare
     * legacy id) onto a catalog row — `piSelectedModel` (`index.tsx` memo).
     */
    fun resolvePiSelectedModel(models: List<PiModelSummary>, model: String): PiModelSummary? {
        if (model == "auto") return null
        val slash = model.indexOf('/')
        if (slash > 0) {
            val provider = model.substring(0, slash)
            val modelId = model.substring(slash + 1)
            return models.firstOrNull { it.provider == provider && it.modelId == modelId }
        }
        return models.firstOrNull { it.modelId == model }
    }

    // -------------------------------------------------------------- opencode --

    /**
     * Static opencode reasoning-effort fallback (web
     * `CODEX_REASONING_EFFORT_OPTIONS` minus `xhigh`; opencode models do not
     * offer it while codex does).
     */
    val OPENCODE_REASONING_EFFORTS: List<OptionItem> = listOf(
        OptionItem("default", "Default"),
        OptionItem("low", "Low"),
        OptionItem("medium", "Medium"),
        OptionItem("high", "High"),
        OptionItem("max", "Max"),
    )

    /**
     * `isOpencodeReasoningEffortValid` (`types.ts`). [dynamicVariants] is the
     * selected model's real variant list when the catalog is loaded (empty =
     * model has none), or null when the static fallback applies.
     */
    fun isOpencodeReasoningEffortValid(effort: String, dynamicVariants: List<String>?): Boolean {
        if (effort == "default") return true
        val allowed = dynamicVariants
            ?: OPENCODE_REASONING_EFFORTS.map { it.value }
        return effort in allowed
    }
}

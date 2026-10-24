package app.hapi.companion.feature.newsession

import app.hapi.protocol.wire.OpencodeModelSummary

/**
 * Cursor model picker logic — a port of the new-session-relevant subset of
 * `shared/src/cursorCliSku.ts`, `web/src/lib/cursorModelOptions.ts`,
 * `web/src/lib/cursorPickerState.ts` and
 * `web/src/components/NewSession/newSessionCursorModels.ts`.
 *
 * Cursor ACP advertises parameterized wire ids (`base[param=value,…]`); the
 * CLI additionally lists sku slugs (`base-high-fast`). The picker groups wires
 * by base, attaches skus as variant rows under a matching base, and switches
 * between dual (base + variant) and flat (one row per wire) modes depending on
 * whether any base carries more than one variant.
 */
object CursorModels {

    const val AUTO = "auto"

    // ----------------------------------------------------------- predicates --

    /** ACP parameterized wire ids use bracket params; CLI sku slugs do not. */
    fun isAcpWireModelId(modelId: String): Boolean {
        val trimmed = modelId.trim()
        return trimmed == "default[]" || trimmed.contains('[')
    }

    /** CLI Auto plus the legacy default aliases that must not stay as options. */
    fun isAutoModelId(modelId: String?): Boolean {
        val normalized = modelId?.trim()?.lowercase()
        return normalized == "auto" || normalized == "default" || normalized == "default[]"
    }

    /** Spawn `--model` value: pin Auto as `auto`; empty means "omit". */
    fun spawnModelId(model: String): String? {
        val trimmed = model.trim()
        if (trimmed.isEmpty()) return null
        return if (isAutoModelId(trimmed)) AUTO else trimmed
    }

    /** Base model id before ACP wire suffix: `composer-2.5[fast=true]` → `composer-2.5`. */
    fun baseId(modelId: String): String {
        val trimmed = modelId.trim()
        val bracket = trimmed.indexOf('[')
        return if (bracket == -1) trimmed else trimmed.substring(0, bracket)
    }

    /** Raw ACP variant suffix without brackets: `x[a=b]` → `a=b`. */
    fun variantId(modelId: String): String {
        val trimmed = modelId.trim()
        val bracket = trimmed.indexOf('[')
        if (bracket == -1) return ""
        val end = if (trimmed.endsWith("]")) trimmed.length - 1 else trimmed.length
        return trimmed.substring(bracket + 1, end)
    }

    private fun stripFamilyPrefix(base: String): String =
        if (base.startsWith("cursor-")) base.substring("cursor-".length) else base

    /**
     * Compare an ACP wire base with a CLI sku base. Cursor's CLI keeps a legacy
     * `cursor-` family prefix for some models, so plain equality would silently
     * drop those variant rows.
     */
    fun baseMatches(a: String, b: String): Boolean {
        val left = a.trim()
        val right = b.trim()
        if (left == right) return true
        return stripFamilyPrefix(left) == stripFamilyPrefix(right)
    }

    /** Longest-first suffixes from Cursor CLI sku ids (shared `CLI_SKU_SUFFIXES`). */
    private val CLI_SKU_SUFFIXES = listOf(
        "-extra-high-fast",
        "-extra-high",
        "-xhigh-fast",
        "-xhigh",
        "-high-fast",
        "-high",
        "-medium-fast",
        "-medium",
        "-low-fast",
        "-low",
        "-none-fast",
        "-none",
        "-thinking-high-fast",
        "-thinking-high",
        "-thinking",
        "-fast",
    )

    /** CLI sku base id by suffix stripping: `gpt-5.5-high-fast` → `gpt-5.5`. */
    fun cliSkuBaseId(slug: String): String {
        val trimmed = slug.trim()
        if (trimmed.isEmpty() || isAcpWireModelId(trimmed)) return baseId(trimmed)
        var base = trimmed
        var changed = true
        while (changed) {
            changed = false
            for (suffix in CLI_SKU_SUFFIXES) {
                if (base.endsWith(suffix)) {
                    base = base.substring(0, base.length - suffix.length)
                    changed = true
                    break
                }
            }
        }
        return base
    }

    /** CLI probe skus that carry effort/speed suffixes; base-only slugs are not variants. */
    fun isCliSkuVariantId(modelId: String): Boolean {
        val trimmed = modelId.trim()
        if (trimmed.isEmpty() || isAcpWireModelId(trimmed)) return false
        return cliSkuBaseId(trimmed) != trimmed
    }

    /**
     * Picker/catalog-eligible ACP model ids: parameterized wires and bare
     * non-default bases; never CLI effort/speed sku slugs (those attach as
     * variant rows under a base).
     */
    fun isAcpCatalogModelId(modelId: String): Boolean {
        val trimmed = modelId.trim()
        if (trimmed.isEmpty()) return false
        val lower = trimmed.lowercase()
        if (lower == "auto" || lower == "default") return false
        if (isAcpWireModelId(trimmed)) return true
        if (isCliSkuVariantId(trimmed)) return false
        return true
    }

    /** Raw variant row label: the suffix, `(default)` for empty brackets, else the base. */
    fun variantLabel(modelId: String): String {
        val variant = variantId(modelId)
        if (variant.isNotEmpty()) return variant
        if (modelId.contains('[')) return "(default)"
        return baseId(modelId)
    }

    /** Flat-picker label from a wire id: `base · variant` or just the base. */
    fun formatPickerLabel(modelId: String): String {
        val base = baseId(modelId)
        val variant = variantId(modelId)
        return if (variant.isNotEmpty()) "$base · $variant" else base
    }

    // -------------------------------------------------------------- catalog --

    /** One variant row under a base. */
    data class VariantOption(val wireId: String, val label: String)

    /**
     * Grouped catalog. [variantsByBase]/[wireToBase] are insertion-ordered
     * (LinkedHashMap) — catalog order is ACP advertise order, only "Auto" is
     * prepended and bases are sorted case-insensitively.
     */
    class Catalog(
        val baseOptions: List<OptionItem>,
        val variantsByBase: Map<String, List<VariantOption>>,
        val wireToBase: Map<String, String>,
    )

    /** `pickCursorModelsForPicker` — ACP catalog rows eligible as top-level picker entries. */
    fun pickModelsForPicker(models: List<OpencodeModelSummary>): List<OpencodeModelSummary> =
        models.filter { isAcpCatalogModelId(it.modelId) }

    /**
     * `buildCursorModelCatalog` — group ACP wire ids by base, injecting the
     * current wire when it is catalog-eligible but unlisted.
     */
    fun buildCatalog(models: List<OpencodeModelSummary>, currentModel: String? = null): Catalog {
        val variantsByBase = LinkedHashMap<String, MutableList<VariantOption>>()
        val wireToBase = LinkedHashMap<String, String>()
        val baseIds = LinkedHashSet<String>()

        fun addWire(rawModelId: String) {
            val modelId = rawModelId.trim()
            if (modelId.isEmpty() || isAutoModelId(modelId)) return
            val base = baseId(modelId)
            wireToBase[modelId] = base
            baseIds.add(base)
            val existing = variantsByBase.getOrPut(base) { mutableListOf() }
            if (existing.none { it.wireId == modelId }) {
                existing.add(VariantOption(modelId, variantLabel(modelId)))
            }
        }

        models.forEach { addWire(it.modelId) }

        val normalizedCurrent = currentModel?.trim()?.takeIf { it.isNotEmpty() && !isAutoModelId(it) }
        if (normalizedCurrent != null && isAcpCatalogModelId(normalizedCurrent) && normalizedCurrent !in wireToBase) {
            addWire(normalizedCurrent)
        }

        val sortedBases = baseIds.sortedWith(compareBy { it.lowercase() })
        val baseOptions = listOf(OptionItem(AUTO, "Auto")) + sortedBases.map { OptionItem(it, it) }
        return Catalog(baseOptions, variantsByBase, wireToBase)
    }

    /**
     * `appendCliSkusToCatalog` — attach `agent --list-models` skus as variant
     * rows under a base that matches (tolerating the legacy `cursor-` prefix).
     * Skus for unknown bases are dropped.
     */
    fun appendCliSkus(catalog: Catalog, cliSkus: List<OpencodeModelSummary>): Catalog {
        if (cliSkus.isEmpty()) return catalog
        val variantsByBase = LinkedHashMap(catalog.variantsByBase.mapValues { it.value.toMutableList() })
        val wireToBase = LinkedHashMap(catalog.wireToBase)

        for (sku in cliSkus) {
            val modelId = sku.modelId.trim()
            if (modelId.isEmpty() || isAutoModelId(modelId) || isAcpWireModelId(modelId)) continue

            val skuBase = cliSkuBaseId(modelId)
            val catalogBase = variantsByBase.keys.firstOrNull { key ->
                key == skuBase || baseMatches(skuBase, key)
            }
            val existing = catalogBase?.let { variantsByBase[it] }
            if (catalogBase == null || existing.isNullOrEmpty()) continue
            if (existing.none { it.wireId == modelId }) {
                val name = sku.name?.trim()
                existing.add(
                    VariantOption(
                        modelId,
                        if (!name.isNullOrEmpty() && name != modelId) name else modelId,
                    ),
                )
                wireToBase[modelId] = catalogBase
            }
        }
        return Catalog(catalog.baseOptions, variantsByBase, wireToBase)
    }

    /** Base key for a wire id: the catalog mapping, else the derived base. */
    fun resolveBaseKey(wireId: String?, catalog: Catalog): String? {
        if (wireId == null) return null
        return catalog.wireToBase[wireId] ?: baseId(wireId)
    }

    /**
     * Variant rows for the picker. When CLI skus exist for a base, hide the raw
     * ACP wire row and show user-facing sku names only.
     */
    fun resolveVariantOptions(baseKey: String?, catalog: Catalog): List<VariantOption> {
        if (baseKey == null) return emptyList()
        val variants = catalog.variantsByBase[baseKey] ?: emptyList()
        val cliSkus = variants.filter { !isAcpWireModelId(it.wireId) }
        return if (cliSkus.isNotEmpty()) cliSkus else variants
    }

    /** True when at least one base carries more than one variant (dual pickers). */
    fun hasMultiVariantBases(catalog: Catalog): Boolean =
        catalog.variantsByBase.values.any { it.size > 1 }

    /** `cursorBaseHasMultipleVariants` — drives the create-time variant guard. */
    fun baseHasMultipleVariants(catalog: Catalog, baseKey: String?): Boolean {
        if (baseKey == null || baseKey == AUTO) return false
        return (catalog.variantsByBase[baseKey]?.size ?: 0) > 1
    }

    /** Flat picker fallback: one row per exact wire id, preserving catalog order. */
    fun buildFlatOptions(catalog: Catalog): List<OptionItem> {
        val rows = mutableListOf<OptionItem>()
        for ((baseId, variants) in catalog.variantsByBase) {
            val baseLabel = catalog.baseOptions.firstOrNull { it.value == baseId }?.label ?: baseId
            for (variant in variants) {
                rows.add(
                    OptionItem(
                        variant.wireId,
                        if (variants.size == 1) formatPickerLabel(variant.wireId) else variantLabel(variant.wireId),
                    ),
                )
            }
        }
        return listOf(OptionItem(AUTO, "Auto")) + rows
    }

    // --------------------------------------------------------- picker state --

    enum class PickerMode { DUAL, FLAT }

    /**
     * The rendered picker (`buildCursorPickerState` + new-session wrappers).
     * [modelOptions] are base rows in dual mode, wire rows in flat mode;
     * [variantOptions] is the current base's variant list (dual only).
     */
    data class PickerState(
        val catalog: Catalog,
        val mode: PickerMode,
        /** Normalized form model: `auto` or an exact wire id. */
        val wireId: String,
        /** Catalog base of [wireId], null when Auto/not in catalog. */
        val baseKey: String?,
        val modelOptions: List<OptionItem>,
        val variantOptions: List<OptionItem>,
        val showVariantPicker: Boolean,
    )

    /**
     * `buildNewSessionCursorModelCatalog` — the reconcile view of the catalog
     * (current pinned at Auto so the form selection is judged, not injected).
     */
    fun buildNewSessionCatalog(
        machineModels: List<OpencodeModelSummary>,
        cliSkus: List<OpencodeModelSummary>,
    ): Catalog = appendCliSkus(
        buildCatalog(pickModelsForPicker(machineModels)),
        cliSkus,
    )

    /** `buildNewSessionCursorPickerState` — includes the form's current wire as catalog hint. */
    fun buildNewSessionPickerState(
        machineModels: List<OpencodeModelSummary>,
        currentModel: String,
        cliSkus: List<OpencodeModelSummary>,
    ): PickerState {
        val trimmed = currentModel.trim()
        val wireHint = if (trimmed.isNotEmpty() && !isAutoModelId(trimmed)) trimmed else null
        val catalog = appendCliSkus(
            buildCatalog(pickModelsForPicker(machineModels), wireHint),
            cliSkus,
        )
        return pickerState(catalog, trimmed)
    }

    /**
     * `buildCursorPickerState` body shared by the create-form and session-sheet
     * builders: resolve the wire → base → variants chain off the catalog.
     */
    private fun pickerState(catalog: Catalog, currentModel: String?): PickerState {
        val trimmed = currentModel?.trim().orEmpty()
        val wireId = if (trimmed.isEmpty() || isAutoModelId(trimmed)) AUTO else trimmed
        val baseKey = if (wireId != AUTO) resolveBaseKey(wireId, catalog) else null
        val useDual = hasMultiVariantBases(catalog)
        val variantBase = if (baseKey != null && baseKey != AUTO) baseKey else null
        val variants = resolveVariantOptions(variantBase, catalog)
        val showVariantPicker = variantBase != null && variants.size > 1

        return PickerState(
            catalog = catalog,
            mode = if (useDual) PickerMode.DUAL else PickerMode.FLAT,
            wireId = wireId,
            baseKey = baseKey,
            modelOptions = if (useDual) catalog.baseOptions else buildFlatOptions(catalog),
            variantOptions = if (showVariantPicker) {
                variants.map { OptionItem(it.wireId, it.label.trim().ifEmpty { variantLabel(it.wireId) }) }
            } else {
                emptyList()
            },
            showVariantPicker = showVariantPicker,
        )
    }

    // ------------------------------------------------- session chat merge --
    // Ports of `mergeCursorModelSummaries` / `mergeCursorCliModelSkus` /
    // `buildSessionCursorPickerState` (`web/src/lib/cursorPickerState.ts`,
    // `web/src/lib/sessionChatCursorModel.ts`) for the session config sheet.

    /**
     * `mergeCursorModelSummaries` — session (ACP) rows win on duplicate ids;
     * machine rows fill display names and extra wires; the current wire is
     * injected last when catalog-eligible but unlisted.
     */
    fun mergeSessionModels(
        primary: List<OpencodeModelSummary>,
        secondary: List<OpencodeModelSummary>,
        currentWireId: String? = null,
    ): List<OpencodeModelSummary> {
        val merged = LinkedHashMap<String, OpencodeModelSummary>()

        fun add(model: OpencodeModelSummary) {
            val modelId = model.modelId.trim()
            if (modelId.isEmpty() || !isAcpCatalogModelId(modelId)) return
            merged.getOrPut(modelId) { model.copy(modelId = modelId) }
        }

        primary.forEach(::add)
        secondary.forEach(::add)
        val trimmedCurrent = currentWireId?.trim()
        if (!trimmedCurrent.isNullOrEmpty() && isAcpCatalogModelId(trimmedCurrent)) {
            merged.getOrPut(trimmedCurrent) { OpencodeModelSummary(modelId = trimmedCurrent) }
        }
        return merged.values.toList()
    }

    /** `mergeCursorCliModelSkus` — longer source first (stable), first occurrence wins per id. */
    fun mergeCliSkus(vararg sources: List<OpencodeModelSummary>): List<OpencodeModelSummary> {
        val merged = LinkedHashMap<String, OpencodeModelSummary>()
        for (source in sources.sortedByDescending { it.size }) {
            for (entry in source) {
                val modelId = entry.modelId.trim()
                if (modelId.isEmpty()) continue
                merged.getOrPut(modelId) { entry.copy(modelId = modelId) }
            }
        }
        return merged.values.toList()
    }

    /**
     * `buildSessionCursorPickerState` — the session-sheet picker. The catalog
     * hint and the rendered selection differ on purpose (web parity): the
     * catalog injects the machine's live wire (`currentModelId`) first, while
     * the selected row prefers the hub-persisted session model.
     */
    fun buildSessionPickerState(
        sessionModels: List<OpencodeModelSummary>,
        machineModels: List<OpencodeModelSummary>,
        cliSkus: List<OpencodeModelSummary>,
        sessionModel: String?,
        sessionCurrentModelId: String?,
    ): PickerState {
        val wireHint = sessionCurrentModelId ?: sessionModel
        val catalog = appendCliSkus(
            buildCatalog(
                pickModelsForPicker(mergeSessionModels(sessionModels, machineModels, wireHint)),
                wireHint,
            ),
            cliSkus,
        )
        return pickerState(catalog, sessionModel ?: sessionCurrentModelId)
    }

    // ------------------------------------------------- sku ↔ wire matching --
    // Ports of the `findBestCliSkuForAcpWire` chain
    // (`shared/src/cursorCliSku.ts`) used by default-variant resolution and
    // ACP-wire → sku-row highlight.

    /** `parseCursorWireParams` — `base[k=v,…]` → param map (bare keys → `"true"`). */
    fun parseWireParams(modelId: String): Map<String, String> {
        val variant = variantId(modelId)
        if (variant.isEmpty()) return emptyMap()
        val params = LinkedHashMap<String, String>()
        for (part in variant.split(',')) {
            val segment = part.trim()
            if (segment.isEmpty()) continue
            val eq = segment.indexOf('=')
            if (eq == -1) {
                params[segment] = "true"
            } else {
                params[segment.substring(0, eq).trim()] = segment.substring(eq + 1).trim()
            }
        }
        return params
    }

    /** `inferSkuParamHints` — effort/speed hints carried by CLI sku suffixes. */
    private fun skuParamHints(slug: String): Map<String, String> {
        val lower = slug.lowercase()
        val hints = LinkedHashMap<String, String>()
        when {
            lower.contains("extra-high") || lower.contains("xhigh") -> {
                hints["reasoning"] = "extra-high"
                hints["effort"] = "xhigh"
            }
            lower.contains("-high") -> {
                hints["reasoning"] = "high"
                hints["effort"] = "high"
            }
            lower.contains("-low") -> {
                hints["reasoning"] = "low"
                hints["effort"] = "low"
            }
            lower.contains("-medium") -> {
                hints["reasoning"] = "medium"
                hints["effort"] = "medium"
            }
            lower.contains("-none") -> hints["reasoning"] = "none"
        }
        // CLI convention: `-fast` means fast=true; absence means false so a
        // base-only sku never tie-breaks onto the fast variant.
        hints["fast"] = if (lower.contains("-fast")) "true" else "false"
        if (lower.contains("thinking")) hints["thinking"] = "true"
        return hints
    }

    /** `scoreWireAgainstSku` — +2 per matching hint, −1 per conflicting one. */
    private fun scoreWireAgainstSku(slug: String, wireId: String): Int {
        val hints = skuParamHints(slug)
        val params = parseWireParams(wireId)
        var score = 0
        for ((key, value) in hints) {
            val wireValue = params[key]
            if (wireValue == value) {
                score += 2
            } else if (wireValue != null) {
                score -= 1
            }
        }
        return score
    }

    /**
     * `matchCliSkuToAcpWireId(sku, [{modelId: wireId}]) === wireId` reduced to
     * the single-wire call shape used here: same base (sku suffixes stripped,
     * tolerating the legacy `cursor-` prefix via [cliSkuBaseId]/[baseId]), and
     * a suffixed sku may not collapse onto a bare, non-parameterized base.
     */
    private fun skuMapsOntoWire(sku: String, wireId: String): Boolean {
        if (!isAcpCatalogModelId(wireId)) return false
        if (baseId(wireId) != cliSkuBaseId(sku)) return false
        if (isCliSkuVariantId(sku) && !isAcpWireModelId(wireId)) return false
        return true
    }

    /** `findBestCliSkuForAcpWire` — highest-scoring CLI sku that maps onto the wire. */
    fun findBestCliSkuForAcpWire(wireId: String, skuIds: List<String>): String? {
        var best: String? = null
        var bestScore = Int.MIN_VALUE
        for (sku in skuIds) {
            val trimmed = sku.trim()
            if (trimmed.isEmpty() || isAcpWireModelId(trimmed)) continue
            if (!skuMapsOntoWire(trimmed, wireId)) continue
            val score = scoreWireAgainstSku(trimmed, wireId)
            if (score > bestScore) {
                bestScore = score
                best = trimmed
            }
        }
        return best
    }

    /**
     * `resolveDefaultCursorVariantWire` — the base's default variant: its
     * first ACP wire in catalog order, mapped to the best CLI sku when skus
     * replace the raw wires in the picker.
     */
    fun defaultVariantWire(baseKey: String, catalog: Catalog): String? {
        val pickerVariants = resolveVariantOptions(baseKey, catalog)
        if (pickerVariants.isEmpty()) return null
        if (pickerVariants.size == 1) return pickerVariants[0].wireId

        val catalogVariants = catalog.variantsByBase[baseKey].orEmpty()
        val defaultAcp = catalogVariants.firstOrNull { isAcpWireModelId(it.wireId) } ?: catalogVariants.first()
        if (pickerVariants.any { it.wireId == defaultAcp.wireId }) return defaultAcp.wireId
        val bestSku = findBestCliSkuForAcpWire(defaultAcp.wireId, pickerVariants.map { it.wireId })
        return bestSku ?: pickerVariants[0].wireId
    }

    /**
     * `buildCursorEffortPickerOptionsWithDefaultFirst` — variant rows with the
     * base default pinned first (the session sheet's variant section order).
     */
    fun variantOptionsDefaultFirst(baseKey: String?, catalog: Catalog): List<OptionItem> {
        val variants = resolveVariantOptions(baseKey, catalog)
        val options = variants.map { OptionItem(it.wireId, it.label.trim().ifEmpty { variantLabel(it.wireId) }) }
        if (baseKey == null) return options
        val defaultWire = defaultVariantWire(baseKey, catalog)
        val defaultOption = options.firstOrNull { it.value == defaultWire } ?: return options
        return listOf(defaultOption) + options.filter { it.value != defaultWire }
    }

    /**
     * `resolveWireIdForBaseChange` — a base switch applies directly only when
     * it maps to exactly one wire; multi-variant bases require an explicit
     * variant pick (returns null = keep Auto until then).
     */
    fun resolveWireIdForBaseChange(baseKey: String, catalog: Catalog): String? {
        if (baseKey == AUTO) return AUTO
        val variants = resolveVariantOptions(baseKey, catalog)
        return if (variants.size == 1) variants[0].wireId else null
    }

    /** `resolveCursorBaseFromWire`. */
    fun resolveBaseFromWire(wireId: String, catalog: Catalog): String {
        if (wireId == AUTO) return AUTO
        return resolveBaseKey(wireId, catalog) ?: baseId(wireId)
    }

    /** Base select value in dual mode (`resolveNewSessionCursorBaseSelectValue`). */
    fun baseSelectValue(picker: PickerState, cursorSelectedBase: String): String {
        if (picker.mode != PickerMode.DUAL) return picker.wireId.ifEmpty { AUTO }
        return cursorSelectedBase
    }

    /**
     * Variant select value (`resolveNewSessionCursorEffortSelectValue`): the
     * wire when it is one of the current variant rows, else the Auto
     * "Select variant" placeholder.
     */
    fun variantSelectValue(model: String, variantOptions: List<OptionItem>): String {
        if (variantOptions.isEmpty()) return AUTO
        if (model != AUTO && variantOptions.any { it.value == model }) return model
        return AUTO
    }

    /**
     * `isCursorEffortWireAllowed` — a variant click is only accepted for wires
     * of the active base (guards stale rows after a catalog swap).
     */
    fun isEffortWireAllowed(wireId: String, catalog: Catalog, baseKey: String?): Boolean {
        if (baseKey == null || baseKey == AUTO) return false
        val variants = catalog.variantsByBase[baseKey] ?: emptyList()
        return variants.any { it.wireId == wireId }
    }
}

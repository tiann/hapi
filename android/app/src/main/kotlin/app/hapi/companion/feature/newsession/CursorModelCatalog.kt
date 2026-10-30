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
        val injectCurrent = wireHint?.takeIf { isAcpCatalogModelId(it) }
        val catalog = appendCliSkus(
            buildCatalog(pickModelsForPicker(machineModels), injectCurrent),
            cliSkus,
        )

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

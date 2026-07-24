import {
    cursorCliSkuBaseId,
    findBestCliSkuForAcpWire,
    isCursorAcpCatalogModelId,
    isCursorAcpWireModelId as isSharedCursorAcpWireModelId
} from '@hapi/protocol'
import type { CursorModelSummary } from '@/types/api'

export type CursorModelOption = { value: string | null; label: string }

export type CursorModelVariantOption = {
    wireId: string
    label: string
    sortKey: string
}

export type CursorModelCatalog = {
    baseOptions: CursorModelOption[]
    variantsByBase: Map<string, CursorModelVariantOption[]>
    wireToBase: Map<string, string>
}

/** Base model id before ACP wire suffix, e.g. `composer-2.5[fast=true]` → `composer-2.5`. */
export function cursorModelBaseId(modelId: string): string {
    const trimmed = modelId.trim()
    const bracket = trimmed.indexOf('[')
    return bracket === -1 ? trimmed : trimmed.slice(0, bracket)
}

/** Raw ACP variant suffix without brackets, e.g. `x[a=b]` → `a=b`. */
export function cursorModelVariantId(modelId: string): string {
    const trimmed = modelId.trim()
    const bracket = trimmed.indexOf('[')
    if (bracket === -1) {
        return ''
    }
    const end = trimmed.endsWith(']') ? trimmed.length - 1 : trimmed.length
    return trimmed.slice(bracket + 1, end)
}

/** Key for grouping variants of the same base model. No legacy alias normalization. */
export function cursorModelDedupeKey(modelId: string): string {
    return cursorModelBaseId(modelId)
}

function isDefaultCursorModelId(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase()
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]'
}

function normalizeCurrentModel(model?: string | null): string | null {
    const trimmed = model?.trim()
    if (!trimmed || isDefaultCursorModelId(trimmed)) {
        return null
    }
    return trimmed
}

export function parseCursorWireParams(modelId: string): Record<string, string> {
    const variant = cursorModelVariantId(modelId)
    if (!variant) {
        return {}
    }

    const params: Record<string, string> = {}
    for (const part of variant.split(',')) {
        const segment = part.trim()
        if (!segment) continue
        const eq = segment.indexOf('=')
        if (eq === -1) {
            params[segment] = 'true'
            continue
        }
        params[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim()
    }
    return params
}

/** Raw label for a variant row. No fast/effort/reasoning formatting. */
export function cursorVariantLabel(modelId: string): string {
    const variant = cursorModelVariantId(modelId)
    if (variant) {
        return variant
    }
    if (modelId.includes('[')) {
        return '(default)'
    }
    return cursorModelBaseId(modelId)
}

/** Kept for callers/tests; sorting is raw and should not encode semantic effort guesses. */
export function cursorEffortPickerSortKey(wireId: string): string {
    return wireId
}

/** Param keys that differ across wire ids in the same base model group. */
export function cursorVaryingWireParamKeys(wireIds: readonly string[]): string[] {
    if (wireIds.length <= 1) {
        return []
    }

    const parsed = wireIds.map((wireId) => parseCursorWireParams(wireId))
    const keys = new Set<string>()
    for (const params of parsed) {
        for (const key of Object.keys(params)) {
            keys.add(key)
        }
    }

    const varying: string[] = []
    for (const key of keys) {
        const values = new Set(parsed.map((params) => params[key] ?? ''))
        if (values.size > 1) {
            varying.push(key)
        }
    }
    return varying
}

/** Raw variant-picker label. */
export function cursorEffortPickerLabel(wireId: string, _siblingWireIds: readonly string[]): string {
    return cursorVariantLabel(wireId)
}

/** Variant-picker rows for one base model, preserving ACP/catalog order. */
export function buildCursorEffortPickerOptions(
    variants: readonly CursorModelVariantOption[]
): Array<{ value: string; label: string }> {
    return variants.map((variant) => ({
        value: variant.wireId,
        label: variant.label.trim() || cursorVariantLabel(variant.wireId)
    }))
}

/**
 * Default variant for a base: the first ACP wire row in catalog order, mapped to
 * the best CLI sku when sku rows replace raw ACP wires in the picker.
 */
export function resolveDefaultCursorVariantWire(
    baseKey: string,
    catalog: CursorModelCatalog
): string | null {
    const pickerVariants = resolveCursorVariantOptions(baseKey, catalog)
    if (pickerVariants.length === 0) {
        return null
    }
    if (pickerVariants.length === 1) {
        return pickerVariants[0].wireId
    }

    const catalogVariants = catalog.variantsByBase.get(baseKey) ?? []
    const defaultAcp = catalogVariants.find((entry) => isCursorAcpWireModelId(entry.wireId))
        ?? catalogVariants[0]
    if (pickerVariants.some((entry) => entry.wireId === defaultAcp.wireId)) {
        return defaultAcp.wireId
    }

    const bestSku = findBestCliSkuForAcpWire(
        defaultAcp.wireId,
        pickerVariants.map((entry) => entry.wireId)
    )
    return bestSku ?? pickerVariants[0].wireId
}

/** Variant rows with the base default first (for drill-down picker step). */
export function buildCursorEffortPickerOptionsWithDefaultFirst(
    baseKey: string,
    catalog: CursorModelCatalog
): Array<{ value: string; label: string }> {
    const variants = resolveCursorVariantOptions(baseKey, catalog)
    const options = buildCursorEffortPickerOptions(variants)
    const defaultWire = resolveDefaultCursorVariantWire(baseKey, catalog)
    if (!defaultWire) {
        return options
    }
    const defaultOption = options.find((option) => option.value === defaultWire)
    if (!defaultOption) {
        return options
    }
    return [
        defaultOption,
        ...options.filter((option) => option.value !== defaultWire)
    ]
}

/** Raw suffix for compatibility with older callers/tests. */
export function cursorVariantDisambiguationSuffix(modelId: string): string {
    return cursorVariantLabel(modelId)
}

/**
 * Group ACP wire ids by raw base model. Labels are raw base ids; variant labels are raw suffixes.
 * Catalog order follows the input order; only `Default` is prepended.
 */
export function buildCursorModelCatalog(
    availableModels: readonly CursorModelSummary[],
    options?: {
        currentModel?: string | null
        /** New-session spawn uses `auto`; active session uses `null` for default. */
        defaultValue?: null | 'auto'
    }
): CursorModelCatalog {
    const defaultValue = options?.defaultValue === 'auto' ? 'auto' : null
    const variantsByBase = new Map<string, CursorModelVariantOption[]>()
    const wireToBase = new Map<string, string>()
    const baseLabels = new Map<string, string>()

    const addWire = (rawModelId: string): void => {
        const modelId = rawModelId.trim()
        if (!modelId || isDefaultCursorModelId(modelId)) {
            return
        }

        const baseId = cursorModelDedupeKey(modelId)
        wireToBase.set(modelId, baseId)
        if (!baseLabels.has(baseId)) {
            baseLabels.set(baseId, baseId)
        }

        const existing = variantsByBase.get(baseId) ?? []
        if (!existing.some((entry) => entry.wireId === modelId)) {
            existing.push({
                wireId: modelId,
                label: cursorVariantLabel(modelId),
                sortKey: modelId
            })
            variantsByBase.set(baseId, existing)
        }
    }

    for (const model of availableModels) {
        addWire(model.modelId)
    }

    const normalizedCurrent = normalizeCurrentModel(options?.currentModel)
    if (normalizedCurrent && isCursorAcpCatalogModelId(normalizedCurrent) && !wireToBase.has(normalizedCurrent)) {
        addWire(normalizedCurrent)
    }

    const sortedBaseEntries = [...baseLabels.entries()]
        .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }))

    const baseOptions: CursorModelOption[] = [
        { value: defaultValue, label: 'Default' },
        ...sortedBaseEntries.map(([baseId, label]) => ({ value: baseId, label }))
    ]

    return { baseOptions, variantsByBase, wireToBase }
}

/** Add CLI `agent --list-models` skus as variant rows under existing ACP wire bases. */
export function appendCliSkusToCatalog(
    catalog: CursorModelCatalog,
    cliSkus: readonly CursorModelSummary[]
): CursorModelCatalog {
    if (cliSkus.length === 0) {
        return catalog
    }

    for (const sku of cliSkus) {
        const modelId = sku.modelId.trim()
        if (!modelId || isDefaultCursorModelId(modelId) || isCursorAcpWireModelId(modelId)) {
            continue
        }

        const baseId = cursorCliSkuBaseId(modelId)
        const existing = catalog.variantsByBase.get(baseId)
        if (!existing || existing.length === 0) {
            continue
        }

        if (existing.some((entry) => entry.wireId === modelId)) {
            continue
        }

        existing.push({
            wireId: modelId,
            label: sku.name?.trim() && sku.name !== modelId ? sku.name.trim() : modelId,
            sortKey: modelId
        })
        catalog.wireToBase.set(modelId, baseId)
    }

    return catalog
}

export function resolveCursorBaseKey(
    wireId: string | null | undefined,
    catalog: CursorModelCatalog
): string | null {
    if (!wireId) {
        return null
    }
    return catalog.wireToBase.get(wireId) ?? cursorModelDedupeKey(wireId)
}

/**
 * Variant rows for the picker. When CLI skus exist for a base, hide the raw ACP wire row
 * (e.g. `context=272k,reasoning=medium,fast=false`) and show user-facing sku names only.
 */
export function resolveCursorVariantOptions(
    baseKey: string | null,
    catalog: CursorModelCatalog
): CursorModelVariantOption[] {
    if (!baseKey) {
        return []
    }
    const variants = catalog.variantsByBase.get(baseKey) ?? []
    const cliSkus = variants.filter((entry) => !isCursorAcpWireModelId(entry.wireId))
    if (cliSkus.length > 0) {
        return cliSkus
    }
    return variants
}

/** True when at least one base model has multiple ACP wire variants. */
export function cursorCatalogHasMultiVariantBases(catalog: CursorModelCatalog): boolean {
    for (const variants of catalog.variantsByBase.values()) {
        if (variants.length > 1) {
            return true
        }
    }
    return false
}

export function cursorBaseHasMultipleVariants(
    catalog: CursorModelCatalog,
    baseKey: string | null | undefined
): boolean {
    if (!baseKey || baseKey === 'auto') {
        return false
    }
    return (catalog.variantsByBase.get(baseKey)?.length ?? 0) > 1
}

/** ACP parameterized wire ids use bracket params; re-export shared predicate. */
export function isCursorAcpWireModelId(modelId: string): boolean {
    return isSharedCursorAcpWireModelId(modelId)
}

/** Dual pickers only when at least one base has multiple ACP wire ids. */
export function shouldUseCursorDualPickers(
    catalog: CursorModelCatalog,
    _currentWireId?: string | null
): boolean {
    return cursorCatalogHasMultiVariantBases(catalog)
}

/** Flat picker fallback: one row per exact wire id, preserving catalog order. */
export function buildFlatCursorModelPickerOptions(
    catalog: CursorModelCatalog,
    options?: { defaultValue?: null | 'auto' }
): Array<{ value: string; label: string }> {
    const defaultValue = options?.defaultValue === 'auto' ? 'auto' : null
    const rows: Array<{ value: string; label: string }> = []

    for (const [baseId, variants] of catalog.variantsByBase) {
        const baseLabel = catalog.baseOptions.find((entry) => entry.value === baseId)?.label ?? baseId
        for (const variant of variants) {
            rows.push({
                value: variant.wireId,
                label: variants.length === 1
                    ? formatCursorModelPickerLabel(variant.wireId)
                    : cursorVariantLabel(variant.wireId)
            })
        }
    }

    return [
        { value: defaultValue ?? 'auto', label: 'Default' },
        ...rows
    ]
}

/** @deprecated Use buildCursorModelCatalog for Cursor sessions. */
export function buildCursorModelOptions(
    availableModels: readonly CursorModelSummary[],
    options?: {
        currentModel?: string | null
        defaultValue?: null | 'auto'
    }
): CursorModelOption[] {
    return buildFlatCursorModelPickerOptions(buildCursorModelCatalog(availableModels, options), options)
}

/** Raw display label from a wire id. */
export function formatCursorModelPickerLabel(modelId: string, _name?: string | null): string {
    const base = cursorModelDedupeKey(modelId)
    const variant = cursorModelVariantId(modelId)
    return variant ? `${base} · ${variant}` : base
}

/**
 * iOS-style "configure my model" view: when a non-Default base is selected, hide
 * every other base row so the user sees Default + selected + (optional Variant
 * section below). Caller appends a "Change model…" toggle to re-expand.
 *
 * Default-row passthrough recognizes both `'auto'` (the in-picker token) and
 * `null` (the underlying base option value) so callers don't need to normalize.
 */
export function filterCursorModelOptionsForCompactView(
    modelOptions: readonly { value: string | null; label: string }[],
    selectedModelBase: string | null | undefined
): readonly { value: string | null; label: string }[] {
    if (!selectedModelBase || selectedModelBase === 'auto') {
        return modelOptions
    }
    return modelOptions.filter(
        (option) => option.value === null
            || option.value === 'auto'
            || option.value === selectedModelBase
    )
}

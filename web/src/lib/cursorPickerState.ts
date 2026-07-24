import { isCursorAcpCatalogModelId } from '@hapi/protocol'
import type { CursorModelSummary } from '@/types/api'
import {
    appendCliSkusToCatalog,
    buildCursorEffortPickerOptions,
    buildCursorModelCatalog,
    buildFlatCursorModelPickerOptions,
    cursorModelDedupeKey,
    resolveCursorBaseKey,
    resolveCursorVariantOptions,
    shouldUseCursorDualPickers,
    type CursorModelCatalog,
    type CursorModelOption
} from '@/lib/cursorModelOptions'

export function mergeCursorCliModelSkus(
    ...sources: readonly (readonly CursorModelSummary[])[]
): CursorModelSummary[] {
    const sorted = [...sources].sort((a, b) => b.length - a.length);
    const merged = new Map<string, CursorModelSummary>();
    for (const source of sorted) {
        for (const entry of source) {
            const modelId = entry.modelId.trim();
            if (!modelId) {
                continue;
            }
            if (!merged.has(modelId)) {
                merged.set(modelId, entry);
            }
        }
    }
    return [...merged.values()];
}

export type CursorPickerMode = 'dual' | 'flat'

export type CursorPickerOption = { value: string; label: string }

export type CursorPickerState = {
    catalog: CursorModelCatalog
    mode: CursorPickerMode
    wireId: string | null
    baseKey: string | null
    modelOptions: CursorPickerOption[]
    effortOptions: CursorPickerOption[]
    showEffortPicker: boolean
}

/**
 * ACP catalog rows for the picker: parameterized wires and bare non-default bases.
 * Never CLI effort/speed SKU slugs (those attach as variants under a base).
 */
export function pickCursorModelsForPicker(
    availableModels: readonly CursorModelSummary[]
): CursorModelSummary[] {
    return availableModels.filter((model) => isCursorAcpCatalogModelId(model.modelId))
}

/**
 * Merge session (ACP) and machine catalogs. Session rows win on duplicate modelId;
 * machine rows fill display names and extra SKUs.
 */
export function mergeCursorModelSummaries(
    primary: readonly CursorModelSummary[],
    secondary: readonly CursorModelSummary[],
    currentWireId?: string | null
): CursorModelSummary[] {
    const merged = new Map<string, CursorModelSummary>()

    const add = (model: CursorModelSummary) => {
        const modelId = model.modelId.trim()
        if (!modelId || !isCursorAcpCatalogModelId(modelId)) {
            return
        }
        if (!merged.has(modelId)) {
            merged.set(modelId, { ...model, modelId })
        }
    }

    for (const model of primary) {
        add(model)
    }
    for (const model of secondary) {
        add(model)
    }

    const trimmedCurrent = currentWireId?.trim()
    if (trimmedCurrent && isCursorAcpCatalogModelId(trimmedCurrent) && !merged.has(trimmedCurrent)) {
        merged.set(trimmedCurrent, { modelId: trimmedCurrent })
    }

    return [...merged.values()]
}

export function buildCursorCatalogFromSources(args: {
    sessionModels: readonly CursorModelSummary[]
    machineModels?: readonly CursorModelSummary[]
    cliModelSkus?: readonly CursorModelSummary[]
    currentWireId?: string | null
    sessionModelFromHub?: string | null
    defaultValue?: null | 'auto'
}): CursorModelCatalog {
    const wireHint = args.currentWireId
        ?? args.sessionModelFromHub
        ?? null
    const merged = mergeCursorModelSummaries(
        args.sessionModels,
        args.machineModels ?? [],
        wireHint
    )
    const injectCurrent = wireHint && isCursorAcpCatalogModelId(wireHint) ? wireHint : null
    const catalog = buildCursorModelCatalog(pickCursorModelsForPicker(merged), {
        currentModel: injectCurrent,
        defaultValue: args.defaultValue
    })
    return appendCliSkusToCatalog(catalog, args.cliModelSkus ?? [])
}

export function normalizeCursorPickerWireId(
    wireId: string | null | undefined,
    defaultToken: 'auto' | null = null
): string | null {
    const trimmed = wireId?.trim()
    if (!trimmed || trimmed === 'auto' || trimmed === 'default' || trimmed === 'default[]') {
        return defaultToken
    }
    return trimmed
}

export function buildCursorPickerState(args: {
    catalog: CursorModelCatalog
    currentWireId?: string | null
    defaultValue?: null | 'auto'
}): CursorPickerState {
    const defaultToken = args.defaultValue === 'auto' ? 'auto' : null
    const wireId = normalizeCursorPickerWireId(args.currentWireId, defaultToken)
    const baseKey = wireId && wireId !== 'auto'
        ? resolveCursorBaseKey(wireId, args.catalog)
        : null

    const useDual = shouldUseCursorDualPickers(args.catalog, wireId === 'auto' ? null : wireId)
    const variantBaseKey = baseKey && baseKey !== 'auto' ? baseKey : null
    const variantsForBase = resolveCursorVariantOptions(variantBaseKey, args.catalog)
    const showEffortPicker = Boolean(variantBaseKey && variantsForBase.length > 1)

    const modelOptions: CursorPickerOption[] = useDual
        ? args.catalog.baseOptions.map((option) => ({
            value: option.value ?? 'auto',
            label: option.label
        }))
        : buildFlatCursorModelPickerOptions(args.catalog, {
            defaultValue: args.defaultValue === 'auto' ? 'auto' : undefined
        }).map((option) => ({
            value: option.value ?? 'auto',
            label: option.label
        }))

    const effortOptions: CursorPickerOption[] = showEffortPicker
        ? buildCursorEffortPickerOptions(variantsForBase)
        : []

    return {
        catalog: args.catalog,
        mode: useDual ? 'dual' : 'flat',
        wireId,
        baseKey,
        modelOptions,
        effortOptions,
        showEffortPicker
    }
}

/**
 * When switching base in dual picker, only apply when the base maps to exactly one wire.
 * Multi-variant bases require an explicit variant click; no "closest" matching.
 */
export function resolveWireIdForBaseChange(
    baseKey: string,
    catalog: CursorModelCatalog,
    _currentWireId?: string | null
): string | null {
    if (baseKey === 'auto') {
        return 'auto'
    }
    const variants = resolveCursorVariantOptions(baseKey, catalog)
    if (variants.length === 1) {
        return variants[0].wireId
    }
    return null
}

export function resolveCursorBaseFromWire(
    wireId: string,
    catalog: CursorModelCatalog
): string {
    if (wireId === 'auto') {
        return 'auto'
    }
    return resolveCursorBaseKey(wireId, catalog) ?? cursorModelDedupeKey(wireId)
}

import type { AgentFlavor } from '@hapi/protocol'
import {
    buildCursorCatalogFromSources,
    buildCursorPickerState,
    pickCursorModelsForPicker,
    resolveCursorBaseFromWire,
    resolveWireIdForBaseChange,
    type CursorPickerState
} from '@/lib/cursorPickerState'
import type { CursorModelCatalog } from '@/lib/cursorModelOptions'
import type { CursorModelSummary } from '@/types/api'

export function shouldShowCursorModelsUnavailable(args: {
    agent: AgentFlavor
    isLoading: boolean
    error: string | null
    availableModels: readonly CursorModelSummary[]
}): boolean {
    return args.agent === 'cursor'
        && !args.isLoading
        && !args.error
        && pickCursorModelsForPicker(args.availableModels).length === 0
}

export function buildNewSessionCursorModelCatalog(
    availableModels: readonly CursorModelSummary[],
    currentModel: string,
    cliModelSkus?: readonly CursorModelSummary[]
): CursorModelCatalog {
    return buildCursorCatalogFromSources({
        sessionModels: [],
        machineModels: availableModels,
        cliModelSkus,
        sessionModelFromHub: currentModel !== 'auto' ? currentModel : null,
        defaultValue: 'auto'
    })
}

export function buildNewSessionCursorPickerState(
    machineModels: readonly CursorModelSummary[],
    currentModel: string,
    cliModelSkus?: readonly CursorModelSummary[]
): CursorPickerState {
    const catalog = buildNewSessionCursorModelCatalog(machineModels, currentModel, cliModelSkus)
    return buildCursorPickerState({
        catalog,
        currentWireId: currentModel,
        defaultValue: 'auto'
    })
}

export function buildNewSessionCursorModelOptions(
    picker: CursorPickerState
): CursorPickerState['modelOptions'] {
    return picker.modelOptions
}

export function buildNewSessionCursorEffortOptions(
    picker: CursorPickerState
): CursorPickerState['effortOptions'] {
    return picker.effortOptions
}

export function shouldShowNewSessionCursorVariantPicker(picker: CursorPickerState): boolean {
    return picker.mode === 'dual' && picker.showEffortPicker && picker.effortOptions.length > 1
}

/** Base row value in dual mode — use explicit base state, not derived catalog baseKey. */
export function resolveNewSessionCursorBaseSelectValue(
    picker: CursorPickerState,
    cursorSelectedBase: string
): string {
    if (picker.mode !== 'dual') {
        return picker.wireId ?? 'auto'
    }
    if (cursorSelectedBase !== 'auto') {
        return cursorSelectedBase
    }
    return 'auto'
}

/** Keep Effort <select> controlled when catalog reloads after Browse remount. */
export function resolveNewSessionCursorEffortSelectValue(
    model: string,
    effortOptions: readonly { value: string }[]
): string {
    if (effortOptions.length === 0) {
        return 'auto'
    }
    if (model !== 'auto' && effortOptions.some((row) => row.value === model)) {
        return model
    }
    return 'auto'
}

export function isCursorEffortWireAllowed(
    wireId: string,
    catalog: CursorModelCatalog,
    baseKey: string | null
): boolean {
    if (!baseKey || baseKey === 'auto') {
        return false
    }
    const variants = catalog.variantsByBase.get(baseKey) ?? []
    return variants.some((entry) => entry.wireId === wireId)
}

export { pickCursorModelsForPicker, resolveWireIdForBaseChange, resolveCursorBaseFromWire }

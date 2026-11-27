import { cursorCliSkuBaseId, cursorModelBaseId, cursorModelBaseMatches, isCursorAcpWireModelId, parseCursorSkuParamHints, parseCursorWireParams } from '@hapi/protocol'
import { resolveDefaultCursorVariantWire } from '@/lib/cursorModelOptions'
import type { CursorModelSummary } from '@/types/api'
import {
    buildCursorCatalogFromSources,
    buildCursorPickerState,
    type CursorPickerState
} from '@/lib/cursorPickerState'

export function resolveSessionCursorBaseSelectValue(picker: CursorPickerState): string {
    return (picker.mode === 'dual' ? picker.baseKey : picker.wireId) ?? 'auto'
}

/** Return the advertised model to apply, or null for an unchanged or stale selection. */
export function resolveSessionCursorModelChange(
    picker: CursorPickerState,
    kind: 'model' | 'parameter',
    value: string | null
): string | null {
    if (kind === 'model') {
        const base = value ?? 'auto'
        if (base === resolveSessionCursorBaseSelectValue(picker)) return null
        if (base === 'auto') return 'auto'
        if (picker.mode === 'dual') return resolveDefaultCursorVariantWire(base, picker.catalog)
    }
    if (!value || value === picker.wireId || !picker.catalog.wireToBase.has(value)) return null
    if (kind === 'parameter' && picker.catalog.wireToBase.get(value) !== picker.baseKey) return null
    return value
}

export function resolveSessionCursorVariantSelectValue(
    sessionModel: string | null | undefined,
    effortOptions: readonly { value: string }[]
): string | null {
    if (!sessionModel || effortOptions.length === 0) {
        return null
    }

    const trimmed = sessionModel.trim()
    const exact = effortOptions.find((option) => option.value === trimmed)
    if (exact) {
        return exact.value
    }

    if (!isCursorAcpWireModelId(trimmed)) return null
    const params = parseCursorWireParams(trimmed)
    if (Object.keys(params).some(key => !['reasoning', 'reasoning_effort', 'effort', 'fast', 'thinking', 'context'].includes(key))) return null
    const effort = params.reasoning ?? params.reasoning_effort ?? params.effort
    if (!effort && !params.fast && !params.thinking) return null

    // A nearest SKU is useful when choosing a default, but a selected row
    // represents the confirmed session and must agree with its settings.
    const matching = effortOptions.filter(({ value }) => {
        const base = cursorCliSkuBaseId(value)
        if (isCursorAcpWireModelId(value) || !cursorModelBaseMatches(base, cursorModelBaseId(trimmed))) return false
        const hints = parseCursorSkuParamHints(value.slice(base.length))
        return (effort === 'xhigh' ? 'extra-high' : effort) === hints.reasoning
            && (params.fast ?? 'false') === hints.fast
            && (params.thinking ?? 'false') === (hints.thinking ?? 'false')
    })
    return matching.length === 1 ? matching[0].value : null
}

export function isSessionCursorCatalogLoading(args: {
    sessionLoading: boolean
    machineLoading: boolean
    hasMachineId: boolean
    sessionError: string | null
    machineError: string | null
}): boolean {
    if (args.sessionLoading) {
        return true
    }
    if (args.hasMachineId && args.machineLoading && !args.machineError) {
        return true
    }
    return false
}

export function isSessionCursorCatalogAwaitingSkus(args: {
    sessionLoading: boolean
    machineLoading: boolean
    sessionError: string | null
    machineError: string | null
    mergedSkus: readonly CursorModelSummary[]
    picker: CursorPickerState | null
}): boolean {
    if (args.sessionLoading || args.machineLoading) {
        return false
    }
    if (args.sessionError || args.machineError) {
        return false
    }
    if (!args.picker || args.picker.mode !== 'dual') {
        return false
    }
    if (args.mergedSkus.length > 0) {
        return false
    }
    return args.picker.showEffortPicker
}

export const SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS = 15_000

export function isSessionCursorCatalogPending(args: {
    sessionLoading: boolean
    machineLoading: boolean
    hasMachineId: boolean
    sessionError: string | null
    machineError: string | null
    mergedSkus: readonly CursorModelSummary[]
    picker: CursorPickerState | null
}): boolean {
    return isSessionCursorCatalogLoading(args)
        || isSessionCursorCatalogAwaitingSkus(args)
}

export function isSessionCursorCatalogPendingWithTimeout(args: {
    sessionLoading: boolean
    machineLoading: boolean
    hasMachineId: boolean
    sessionError: string | null
    machineError: string | null
    mergedSkus: readonly CursorModelSummary[]
    picker: CursorPickerState | null
    awaitingStartedAtMs: number | null
    nowMs?: number
    timeoutMs?: number
}): boolean {
    if (!isSessionCursorCatalogPending(args)) {
        return false
    }
    if (!isSessionCursorCatalogAwaitingSkus(args)) {
        return true
    }
    if (args.awaitingStartedAtMs === null) {
        return true
    }
    const elapsed = (args.nowMs ?? Date.now()) - args.awaitingStartedAtMs
    return elapsed < (args.timeoutMs ?? SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS)
}

export function buildSessionCursorPickerState(args: {
    sessionModels: readonly CursorModelSummary[]
    machineModels: readonly CursorModelSummary[]
    cliModelSkus?: readonly CursorModelSummary[]
    sessionModel: string | null | undefined
    sessionCurrentModelId: string | null
    autoRestartLabel?: string
    accountDefaultLabel?: string
}): CursorPickerState {
    const catalog = buildCursorCatalogFromSources({
        sessionModels: args.sessionModels,
        machineModels: args.machineModels,
        cliModelSkus: args.cliModelSkus,
        currentWireId: args.sessionCurrentModelId ?? args.sessionModel,
        sessionModelFromHub: args.sessionModel,
        defaultValue: 'auto'
    })
    const picker = buildCursorPickerState({
        catalog,
        currentWireId: args.sessionModel ?? args.sessionCurrentModelId,
        defaultValue: 'auto'
    })
    // A default catalog hint is common on startup, including when launched with
    // --model auto. An explicit default reported in the session state is distinct:
    // show it as the current model and keep the Auto action available to retry.
    const reported = args.sessionModel?.trim()
    if (reported === 'default' || reported === 'default[]') {
        picker.wireId = reported
        picker.baseKey = reported
        picker.modelOptions.push({ value: reported, label: args.accountDefaultLabel ?? 'Default' })
    }
    const autoRestartLabel = args.autoRestartLabel
    if (autoRestartLabel && !args.sessionModels.some(model => model.modelId.trim() === 'auto')) {
        picker.modelOptions = picker.modelOptions.map(option => option.value === 'auto'
            ? { ...option, label: autoRestartLabel }
            : option)
    }
    return picker
}

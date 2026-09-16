import type { GrokModelSummary, KimiModelSummary } from '@/types/api'
import type { AgentType } from './types'

export function shouldEnableGrokModelDiscovery(args: {
    agent: AgentType
    machineId: string | null
    cwd: string
    cwdExists: boolean | undefined
}): boolean {
    return args.agent === 'grok'
        && Boolean(args.machineId)
        && args.cwd.length > 0
        && args.cwdExists === true
}

export function buildGrokModelOptions(
    availableModels: GrokModelSummary[]
): Array<{ value: string; label: string }> {
    return [
        { value: 'auto', label: 'Default' },
        ...availableModels.map((model) => ({
            value: model.modelId,
            label: model.name ?? model.modelId
        }))
    ]
}

export function buildGrokEffortOptions(
    availableModels: GrokModelSummary[],
    selectedModel: string,
    currentModelId: string | null
): Array<{ value: string; label: string }> {
    const effectiveModel = selectedModel === 'auto' ? currentModelId : selectedModel
    const efforts = availableModels.find((model) => model.modelId === effectiveModel)?.reasoningEfforts
    if (!efforts || efforts.length === 0) {
        return [
            { value: 'auto', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
        ]
    }
    return [
        { value: 'auto', label: 'Default' },
        ...efforts.map((effort) => ({
            value: effort.value,
            label: effort.name ?? effort.value
        }))
    ]
}

export function shouldEnableKimiModelDiscovery(args: {
    agent: AgentType
    machineId: string | null
    cwd: string
    cwdExists: boolean | undefined
}): boolean {
    return args.agent === 'kimi'
        && Boolean(args.machineId)
        && args.cwd.length > 0
        && args.cwdExists === true
}

/**
 * Kimi options for the create-session selector: Default plus one entry per
 * discovered provider model. `value` is always the real Kimi alias; the label
 * makes the provider recognizable ("TheHive — GLM-5.3-flash").
 */
export function buildKimiModelOptions(
    availableModels: KimiModelSummary[]
): Array<{ value: string; label: string }> {
    return [
        { value: 'auto', label: 'Default' },
        ...availableModels.map((model) => ({
            value: model.modelId,
            label: model.provider ? `${model.provider} — ${model.name ?? model.modelId}` : (model.name ?? model.modelId)
        }))
    ]
}

/**
 * Options for a running Kimi session's model picker: Default (null value,
 * cleared via session/set_model) plus the dynamically discovered models.
 * Labels match buildKimiModelOptions so both pickers read the same.
 */
export function buildKimiSessionModelOptions(
    availableModels: KimiModelSummary[]
): Array<{ value: string | null; label: string }> {
    return [
        { value: null, label: 'Default' },
        ...availableModels.map((model) => ({
            value: model.modelId,
            label: model.provider ? `${model.provider} — ${model.name ?? model.modelId}` : (model.name ?? model.modelId)
        }))
    ]
}

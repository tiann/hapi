import type { GrokModelSummary } from '@/types/api'
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

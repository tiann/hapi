import type { DshModelSelection, DshModelSummary } from '@/types/api'

export type DshModelOption = { value: string; label: string }
export type DshReasoningOption = { value: string; name?: string }

function isCurrentModel(model: DshModelSummary, current: DshModelSelection | null): boolean {
    return model.provider === current?.provider && model.modelId === current.modelId
}

export function getDshModelValue(
    model: DshModelSummary,
    models: readonly DshModelSummary[],
    current: DshModelSelection | null
): string {
    const duplicate = models.some((candidate) => (
        candidate !== model
        && candidate.modelId === model.modelId
        && candidate.provider !== model.provider
    ))
    if (!duplicate || isCurrentModel(model, current)) return model.modelId
    return `${model.provider}/${model.modelId}`
}

export function buildDshModelOptions(
    models: readonly DshModelSummary[],
    current: DshModelSelection | null
): DshModelOption[] {
    return models.map((model) => ({
        value: getDshModelValue(model, models, current),
        label: models.some((candidate) => candidate !== model && candidate.modelId === model.modelId)
            ? `${model.name} (${model.providerName})`
            : model.name
    }))
}

export function getDshReasoningOptions(
    models: readonly DshModelSummary[],
    current: DshModelSelection | null,
    selectedModel?: string | null
): DshReasoningOption[] {
    const selection = selectedModel && selectedModel !== 'auto'
        ? models.find((model) => (
            getDshModelValue(model, models, current) === selectedModel
            || `${model.provider}/${model.modelId}` === selectedModel
        ))
        : models.find((model) => isCurrentModel(model, current))
    return selection?.reasoningEfforts.map((effort) => ({
        value: effort.id,
        name: effort.name
    })) ?? []
}

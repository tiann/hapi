import type { CodexModelSummary } from '@/types/api'

type ModelSelection = string | { modelId: string } | null | undefined

function normalizeEfforts(efforts: readonly string[] | undefined): string[] | undefined {
    if (!efforts) return undefined

    const normalized = [...new Set(
        efforts
            .map((effort) => effort.trim().toLowerCase())
            .filter(Boolean)
    )]
    return normalized.length > 0 ? normalized : undefined
}

export function resolveCodexModel(
    models: readonly CodexModelSummary[],
    model: ModelSelection
): CodexModelSummary | null {
    const normalizedModelId = (typeof model === 'string' ? model : model?.modelId)?.trim()
    if (!normalizedModelId || normalizedModelId === 'auto') {
        return models.find((model) => model.isDefault) ?? models[0] ?? null
    }

    return models.find((model) => model.id === normalizedModelId) ?? null
}

export function getCodexModelReasoningEfforts(
    models: readonly CodexModelSummary[],
    model: ModelSelection
): string[] | undefined {
    return normalizeEfforts(resolveCodexModel(models, model)?.supportedReasoningEfforts)
}

export function supportsCodexReasoningEffort(
    models: readonly CodexModelSummary[],
    model: ModelSelection,
    effort: string | null | undefined
): boolean | undefined {
    const supportedEfforts = getCodexModelReasoningEfforts(models, model)
    if (!supportedEfforts) return undefined
    if (!effort) return true
    return supportedEfforts.includes(effort.trim().toLowerCase())
}

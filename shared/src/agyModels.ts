import type { AgyModelSummary } from './apiTypes'

export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type AgyEffortLevel = typeof AGY_EFFORT_LEVELS[number]

export type AgyModelChoice = {
    modelId: string
    name: string
    supportedEfforts: AgyEffortLevel[]
}

export function splitAgyModelSelection(model: string | null | undefined): {
    model: string | null
    effort: AgyEffortLevel | null
} {
    const value = model?.trim()
    if (!value || value === 'auto' || value === 'default') {
        return { model: null, effort: null }
    }
    // Custom names can end in words such as "high" without being effort variants.
    const match = /^(gemini-.+|claude-.+|gpt-oss-.+)-(low|medium|high|xhigh|max)$/.exec(value)
    return match
        ? { model: match[1]!, effort: match[2] as AgyEffortLevel }
        : { model: value, effort: null }
}

export function getAgyModelChoices(catalog: readonly AgyModelSummary[]): AgyModelChoice[] {
    const effortsByModel = new Map<string, Set<AgyEffortLevel>>()
    for (const entry of catalog) {
        const { model, effort } = splitAgyModelSelection(entry.modelId)
        if (!model || !effort) continue
        const efforts = effortsByModel.get(model) ?? new Set<AgyEffortLevel>()
        efforts.add(effort)
        effortsByModel.set(model, efforts)
    }

    const choices = new Map<string, AgyModelChoice>()
    for (const entry of catalog) {
        const { model, effort } = splitAgyModelSelection(entry.modelId)
        if (!model) continue
        const efforts = effortsByModel.get(model)
        // A single variant (e.g. GPT-OSS Medium) does not establish adjustable effort.
        const adjustable = efforts !== undefined && efforts.size > 1
        const modelId = adjustable ? model : entry.modelId
        if (choices.has(modelId)) continue
        const name = adjustable && effort
            ? (entry.name?.replace(new RegExp(`\\s*\\(${effort}\\)$`, 'i'), '') ?? model)
            : (entry.name ?? entry.modelId)
        choices.set(modelId, {
            modelId,
            name,
            supportedEfforts: adjustable ? AGY_EFFORT_LEVELS.filter((level) => efforts.has(level)) : []
        })
    }
    return [...choices.values()]
}

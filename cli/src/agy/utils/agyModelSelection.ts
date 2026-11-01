import {
    AGY_EFFORT_LEVELS,
    getAgyModelChoices,
    splitAgyModelSelection,
    type AgyEffortLevel,
    type AgyModelSummary,
} from '@hapi/protocol'

export type AgyModelSelection = { model: string | null; effort: AgyEffortLevel | null }

/** Normalize launch/resume and RPC config against the catalog, before it is queued. */
export function normalizeAgyModelSelection(
    model: string | null | undefined,
    effort: string | null | undefined,
    catalog: readonly AgyModelSummary[],
): AgyModelSelection {
    if (effort != null && !(AGY_EFFORT_LEVELS as readonly string[]).includes(effort)) {
        throw new Error(`Invalid Antigravity effort: ${effort}`)
    }
    const split = splitAgyModelSelection(model)
    const choices = getAgyModelChoices(catalog)
    const originalModel = model?.trim() || null
    const choice = choices.find((candidate) => candidate.modelId === originalModel)
        ?? choices.find((candidate) => candidate.modelId === split.model)

    // A catalog entry with no variants is a fixed model. Do not turn its name
    // into a base model that agy may not support, or carry a previous model's effort.
    if (choice && choice.supportedEfforts.length === 0) {
        return { model: choice.modelId, effort: null }
    }
    const selectedEffort = effort === undefined ? split.effort : effort as AgyEffortLevel | null
    if (choice) {
        if (selectedEffort && !choice.supportedEfforts.includes(selectedEffort)) {
            throw new Error(`Antigravity model ${choice.modelId} does not support effort ${selectedEffort}`)
        }
        return { model: choice.modelId, effort: selectedEffort }
    }

    // An unavailable/stale catalog cannot prove a native suffix model has a
    // configurable base. Keep its exact wire id unless the requested effort
    // would conflict; custom model names are never rewritten by suffix guessing.
    if (split.effort) {
        if (effort !== undefined && effort !== split.effort) {
            throw new Error(`Cannot change effort for ${originalModel}: refresh the Antigravity model catalog first`)
        }
        return { model: originalModel, effort: null }
    }
    return { model: split.model, effort: selectedEffort }
}

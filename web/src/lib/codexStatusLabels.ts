import { showsDefaultEffortLabel, supportsEffort, usesSessionModelReasoningEffort } from '@hapi/protocol'

/** Labels shared by SessionHeader and composer StatusBar for supported reasoning providers. */

export function formatCompactReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'default'
    return normalized
}

export function formatReasoningLabel(effort?: string | null, showLabel = true): string {
    const value = formatCompactReasoningLabel(effort)
    return showLabel ? `effort ${value}` : value
}

export function getReasoningEffortForFlavor(
    agentFlavor: string | null | undefined,
    modelReasoningEffort?: string | null,
    effort?: string | null
): string | null {
    if (usesSessionModelReasoningEffort(agentFlavor)) {
        return modelReasoningEffort?.trim() || null
    }
    if (supportsEffort(agentFlavor)) {
        return effort?.trim() || null
    }
    return null
}

export function shouldShowReasoningStatusLabel(
    agentFlavor: string | null | undefined,
    reasoningEffort?: string | null
): boolean {
    if (showsDefaultEffortLabel(agentFlavor)) return true
    return supportsEffort(agentFlavor) && Boolean(reasoningEffort?.trim())
}

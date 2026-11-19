/** HAPI stores Fast as `fast`; Codex uses the catalog request id `priority`. */
export function toCodexServiceTier(tier: string | null | undefined): string | null | undefined {
    if (tier === 'fast') return 'priority'
    if (tier === 'ultrafast') return 'ultrafast'
    if (tier === 'standard') return null
    return undefined
}

export function fromCodexServiceTier(tier: unknown): 'standard' | 'fast' | 'ultrafast' {
    if (tier === 'ultrafast') return 'ultrafast'
    return tier === 'priority' || tier === 'fast' ? 'fast' : 'standard'
}

/** Availability belongs to the current account's model catalog, not model-name heuristics. */
export function codexModelHasUltrafastTier(model: { serviceTiers?: readonly string[] } | undefined): boolean {
    return Boolean(model?.serviceTiers?.some(tier => tier === 'ultrafast'))
}

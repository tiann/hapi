/** HAPI stores Fast as `fast`; Codex uses the catalog request id `priority`. */
export function toCodexServiceTier(tier: string | null | undefined): string | null | undefined {
    if (tier === 'fast') return 'priority'
    if (tier === 'ultrafast') return 'ultrafast'
    if (tier === 'standard') return null
    return undefined
}

export function fromCodexServiceTier(tier: unknown): string | null {
    if (tier === 'default') return 'standard'
    if (tier === 'priority') return 'fast'
    // A reported native-only tier (such as Flex) is distinct from an absent
    // runtime tier, which consumers may resolve from the model catalog.
    return typeof tier === 'string' && tier.trim() ? tier : null
}

/** Availability belongs to the current account's model catalog, not model-name heuristics. */
export function codexModelHasUltrafastTier(model: { serviceTiers?: readonly string[] } | undefined): boolean {
    return Boolean(model?.serviceTiers?.some(tier => tier === 'ultrafast'))
}

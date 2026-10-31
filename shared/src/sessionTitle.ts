type ForkTitleSource = { name?: string; summary?: { text?: string } }

/** A fork starts with its parent's display title until the Hub generates one. */
export function buildForkSessionSummary(metadata: ForkTitleSource | null | undefined, updatedAt = Date.now()) {
    const title = metadata?.name?.trim() || metadata?.summary?.text?.trim()
    return title ? { text: `Fork: ${title}`, updatedAt } : undefined
}

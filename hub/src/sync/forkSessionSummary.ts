type ForkSessionTitleSource = {
    name?: string
    summary?: { text?: string }
}

export type ForkSessionSummary = {
    text: string
    updatedAt: number
}

/** Seed a fork's generated/native title without claiming manual-name ownership. */
export function buildForkSessionSummary(
    metadata: ForkSessionTitleSource | null | undefined,
    updatedAt: number = Date.now()
): ForkSessionSummary | undefined {
    const sourceTitle = metadata?.name?.trim() || metadata?.summary?.text?.trim()
    if (!sourceTitle) return undefined

    return {
        text: `Fork: ${sourceTitle}`,
        updatedAt
    }
}

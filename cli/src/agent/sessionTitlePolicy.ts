import type { ApiSessionClient } from '@/api/apiSession'
import type { Metadata } from '@/api/types'

type SessionTitleClient = Pick<ApiSessionClient, 'updateMetadata'>

export type SessionTitleSummaryOptions = {
    allowForkSeedReplacement?: boolean
}

/** A Fork seed is a provisional title until the child agent names itself. */
export function isForkSeedSummary(metadata: Readonly<Metadata> | null | undefined): boolean {
    const summary = metadata?.summary?.text.trim()
    return Boolean(metadata?.forkedFrom?.trim() && summary?.startsWith('Fork: '))
}

/**
 * Apply an agent-generated title without replacing a user-owned or settled
 * title. Callers must explicitly opt in before replacing a Fork seed, because
 * some fallback inputs are ordinary user messages rather than titles.
 */
export function applySessionTitleSummary(
    client: SessionTitleClient,
    title: string,
    options: SessionTitleSummaryOptions = {}
): boolean {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return false

    client.updateMetadata((metadata) => {
        if (metadata.name?.trim()) return metadata

        const summary = metadata.summary?.text.trim()
        const canReplaceForkSeed = options.allowForkSeedReplacement === true && isForkSeedSummary(metadata)
        if (summary && !canReplaceForkSeed) return metadata

        return {
            ...metadata,
            summary: {
                text: normalizedTitle,
                updatedAt: Date.now()
            }
        }
    })
    return true
}

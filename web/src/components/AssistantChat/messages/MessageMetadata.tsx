import type { UsageData } from '@/chat/types'

export type MessageMetadataProps = {
    durationMs?: number
    usage?: UsageData
    model?: string | null
    /**
     * Distinct turn count for the surrounding response group. Single-turn
     * footers pass `undefined` (or any value < 2).
     */
    turnCount?: number
    className?: string
}

export function buildMessageMetadataLabels({ durationMs, usage, model, turnCount }: Omit<MessageMetadataProps, 'className'>): string[] {
    const parts: string[] = []
    // Aggregated footers represent a response group with multiple distinct
    // turns. When the caller passes `turnCount >= 2` they have already
    // dedup-joined `model` into a comma-separated list and summed `usage`
    // across turns; we adjust the labels to reflect that.
    const isAggregated = typeof turnCount === 'number' && turnCount >= 2

    if (typeof durationMs === 'number' && durationMs >= 0) {
        parts.push(`Duration: ${(durationMs / 1000).toFixed(1)}s`)
    }

    const tier = usage?.service_tier
    const isStandardTier = tier?.toLowerCase() === 'standard'
    if (model) {
        // Pluralize the label when the caller has joined multiple model ids.
        const modelLabel = isAggregated && model.includes(', ') ? 'Models' : 'Model'
        let label = `${modelLabel}: ${model}`
        if (tier && !isStandardTier) label += ` (${tier})`
        parts.push(label)
    } else if (tier && !isStandardTier) {
        parts.push(`Tier: ${tier}`)
    }

    if (usage) {
        // "Billable" because cache_read tokens are not part of the input
        // figure used for billing; surfacing only input + output here is
        // intentional. If we ever surface cache I/O, keep this label and
        // add a separate `Cache:` line.
        const total = usage.input_tokens + usage.output_tokens
        const formatToken = (n: number) => n.toLocaleString()
        const usageLabel = isAggregated ? 'Total' : 'Usage'
        parts.push(`${usageLabel}: ${formatToken(total)} billable tokens (${formatToken(usage.input_tokens)} in / ${formatToken(usage.output_tokens)} out)`)
    }

    if (isAggregated) {
        parts.push(`${turnCount} turns`)
    }

    return parts
}

export function MessageMetadata({ durationMs, usage, model, turnCount, className }: MessageMetadataProps) {
    const parts = buildMessageMetadataLabels({ durationMs, usage, model, turnCount })
    if (parts.length === 0) return null

    return (
        <div className={`flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)] ${className || ''}`}>
            {parts.map((part, i) => (
                <span key={i} className="break-words">{part}</span>
            ))}
        </div>
    )
}

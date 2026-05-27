import type { UsageData } from '@/chat/types'

export type MessageMetadataProps = {
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    /**
     * Distinct turn count for the surrounding response group. Single-turn
     * footers pass `undefined` (or any value < 2) so the existing
     * `Invoke · Model · Usage` output is preserved byte-for-byte.
     */
    turnCount?: number
    className?: string
}

export function buildMessageMetadataLabels({ invokedAt, durationMs, usage, model, turnCount }: Omit<MessageMetadataProps, 'className'>): string[] {
    const parts: string[] = []
    // Aggregated footers represent a response group with multiple distinct
    // turns. When the caller passes `turnCount >= 2` they have already
    // dedup-joined `model` into a comma-separated list and summed `usage`
    // across turns; we adjust the labels to reflect that.
    const isAggregated = typeof turnCount === 'number' && turnCount >= 2

    // Explicit nullish checks — `if (invokedAt)` would drop epoch 0, and
    // `if (durationMs)` would drop legitimate 0 ms turns.
    if (invokedAt != null) {
        const time = new Date(invokedAt).toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        })
        parts.push(`Invoke: ${time}`)
    }

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

export function MessageMetadata({ invokedAt, durationMs, usage, model, turnCount, className }: MessageMetadataProps) {
    const parts = buildMessageMetadataLabels({ invokedAt, durationMs, usage, model, turnCount })
    if (parts.length === 0) return null

    return (
        <div className={`text-[10px] text-[var(--app-hint)] bg-[var(--app-subtle-bg)] rounded px-2 py-1.5 flex flex-wrap gap-x-2 gap-y-0.5 mt-1 leading-tight ${className || ''}`}>
            {parts.map((part, i) => (
                <span key={i} className="whitespace-nowrap">{part}</span>
            ))}
        </div>
    )
}

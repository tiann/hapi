import type { RoundModelUsage, RoundSummary, UsageData } from '@/chat/types'

export type MessageMetadataProps = {
    durationMs?: number
    usage?: UsageData
    model?: string | null
    /**
     * Distinct turn count for the surrounding response group. Single-turn
     * footers pass `undefined` (or any value < 2).
     */
    turnCount?: number
    roundSummary?: RoundSummary
    className?: string
}

function formatCompactTokenCount(value: number): string {
    if (value < 1_000) return Math.round(value).toLocaleString()
    const divisor = value >= 1_000_000 ? 1_000_000 : 1_000
    const suffix = divisor === 1_000_000 ? 'm' : 'k'
    return `${(Math.round((value / divisor) * 10) / 10).toString()}${suffix}`
}

function formatPercentage(value: number): string {
    return (Math.round(value * 10) / 10).toString()
}

function formatUsd(value: number): string {
    if (value < 0.0001) return '<$0.0001'
    return value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`
}

function getRoundUsage(summary: RoundSummary): UsageData | undefined {
    const entries = Object.values(summary.modelUsage)
    const hasModelToken = entries.some((usage: RoundModelUsage) => Object.values(usage).some(token => typeof token === 'number'))
    if (!hasModelToken) return summary.usage

    return entries.reduce<UsageData>((total, usage) => ({
        input_tokens: total.input_tokens + (usage.inputTokens ?? 0),
        output_tokens: total.output_tokens + (usage.outputTokens ?? 0),
        cache_creation_input_tokens: (total.cache_creation_input_tokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
        cache_read_input_tokens: (total.cache_read_input_tokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
    }), { input_tokens: 0, output_tokens: 0 })
}

function buildRoundSummaryLabels(summary: RoundSummary, fallbackModel?: string | null): string[] {
    const parts: string[] = []
    const models = Object.keys(summary.modelUsage)
    const model = models.length > 0 ? models.join(', ') : fallbackModel
    if (model) parts.push(`${models.length > 1 ? 'Models' : 'Model'}: ${model}`)

    const usage = getRoundUsage(summary)
    if (usage) {
        const input = usage.input_tokens
            + (usage.cache_creation_input_tokens ?? 0)
            + (usage.cache_read_input_tokens ?? 0)
        const total = input + usage.output_tokens
        parts.push(`Tokens: ${formatCompactTokenCount(total)} (${formatCompactTokenCount(input)} in · ${formatCompactTokenCount(usage.output_tokens)} out)`)

        const economics: string[] = []
        if (input > 0 && (usage.cache_read_input_tokens ?? 0) > 0) {
            economics.push(`Cache read: ${formatPercentage(((usage.cache_read_input_tokens ?? 0) / input) * 100)}% of input`)
        }
        if (summary.totalCostUsd !== undefined && summary.totalCostUsd > 0) {
            economics.push(`API-rate est.: ${formatUsd(summary.totalCostUsd)}`)
        }
        if (economics.length > 0) parts.push(economics.join(' · '))
    } else if (summary.totalCostUsd !== undefined && summary.totalCostUsd > 0) {
        parts.push(`API-rate est.: ${formatUsd(summary.totalCostUsd)}`)
    }

    const round: string[] = []
    if (summary.durationMs !== undefined && summary.durationMs >= 0) round.push(`${(summary.durationMs / 1000).toFixed(1)}s`)
    if (summary.numTurns !== undefined && summary.numTurns > 0) round.push(`${summary.numTurns} internal turn${summary.numTurns === 1 ? '' : 's'}`)
    if (round.length > 0) parts.push(`Round: ${round.join(' · ')}`)
    return parts
}

export function buildMessageMetadataLabels({ durationMs, usage, model, turnCount, roundSummary }: Omit<MessageMetadataProps, 'className'>): string[] {
    if (roundSummary) return buildRoundSummaryLabels(roundSummary, model)
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
        const total = usage.input_tokens + usage.output_tokens
        const formatToken = (n: number) => n.toLocaleString()
        parts.push(`Tokens: ${formatToken(total)} total (${formatToken(usage.input_tokens)} in / ${formatToken(usage.output_tokens)} out)`)
    }

    if (isAggregated) {
        parts.push(`${turnCount} turns`)
    }

    return parts
}

export function MessageMetadata({ durationMs, usage, model, turnCount, roundSummary, className }: MessageMetadataProps) {
    const parts = buildMessageMetadataLabels({ durationMs, usage, model, turnCount, roundSummary })
    if (parts.length === 0) return null

    return (
        <div className={`flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)] ${className || ''}`}>
            {parts.map((part, i) => (
                <span key={i} className="break-words">{part}</span>
            ))}
        </div>
    )
}

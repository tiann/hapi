import type { UsageData } from '@/chat/types'

export type MessageMetadataProps = {
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    className?: string
}

export function buildMessageMetadataLabels({ invokedAt, durationMs, usage, model }: Omit<MessageMetadataProps, 'className'>): string[] {
    const parts: string[] = []

    if (invokedAt) {
        const time = new Date(invokedAt).toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        })
        parts.push(`Invoke: ${time}`)
    }

    if (durationMs) {
        parts.push(`Duration: ${(durationMs / 1000).toFixed(1)}s`)
    }

    const tier = usage?.service_tier
    const isStandardTier = tier?.toLowerCase() === 'standard'
    if (model) {
        let label = `Model: ${model}`
        if (tier && !isStandardTier) label += ` (${tier})`
        parts.push(label)
    } else if (tier && !isStandardTier) {
        parts.push(`Tier: ${tier}`)
    }

    if (usage) {
        const total = usage.input_tokens + usage.output_tokens
        const formatToken = (n: number) => n.toLocaleString()
        parts.push(`Usage: ${formatToken(total)} tokens (${formatToken(usage.input_tokens)} in / ${formatToken(usage.output_tokens)} out)`)
    }

    return parts
}

export function MessageMetadata({ invokedAt, durationMs, usage, model, className }: MessageMetadataProps) {
    const parts = buildMessageMetadataLabels({ invokedAt, durationMs, usage, model })
    if (parts.length === 0) return null

    return (
        <div className={`text-[10px] text-[var(--app-hint)] flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5 px-0.5 leading-tight opacity-60 ${className || ''}`}>
            {parts.map((part, i) => (
                <span key={i} className="whitespace-nowrap">{part}</span>
            ))}
        </div>
    )
}

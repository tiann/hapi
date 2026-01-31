import type { MessageUsage } from './schemas'

export function extractUsageFromMessage(content: unknown): MessageUsage | undefined {
    if (!content || typeof content !== 'object') return undefined

    if ('usage' in content && typeof content.usage === 'object' && content.usage !== null) {
        const usage = content.usage as Record<string, unknown>
        const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
        const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
        const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
        const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
        const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

        if (inputTokens !== undefined && outputTokens !== undefined) {
            return {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreation,
                cache_read_input_tokens: cacheRead,
                service_tier: serviceTier
            }
        }
    }

    if ('content' in content && typeof content.content === 'object' && content.content !== null) {
        const contentObj = content.content as Record<string, unknown>
        if ('type' in contentObj && contentObj.type === 'output' && 'data' in contentObj && typeof contentObj.data === 'object') {
            const data = contentObj.data as Record<string, unknown>
            if ('message' in data && typeof data.message === 'object' && data.message !== null) {
                const message = data.message as Record<string, unknown>
                if ('usage' in message && typeof message.usage === 'object' && message.usage !== null) {
                    const usage = message.usage as Record<string, unknown>
                    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
                    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
                    const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
                    const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
                    const serviceTier = typeof usage.service_tier === 'string' ? usage.service_tier : undefined

                    if (inputTokens !== undefined && outputTokens !== undefined) {
                        return {
                            input_tokens: inputTokens,
                            output_tokens: outputTokens,
                            cache_creation_input_tokens: cacheCreation,
                            cache_read_input_tokens: cacheRead,
                            service_tier: serviceTier
                        }
                    }
                }
            }
        }
    }

    return undefined
}

import type { PiModelSummary } from '@/types/api'

type ProviderGroup = {
    provider: string
    label: string
    models: PiModelSummary[]
}

/** Format provider name for display */
function formatProviderLabel(provider: string): string {
    if (provider === 'unknown') return 'Other'
    // Capitalize first letter, keep rest as-is
    return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** Group Pi models by provider, preserving original order within each group */
export function groupModelsByProvider(models: PiModelSummary[]): ProviderGroup[] {
    const groupOrder: string[] = []
    const groups = new Map<string, PiModelSummary[]>()

    for (const model of models) {
        const provider = model.provider || 'unknown'
        if (!groups.has(provider)) {
            groupOrder.push(provider)
            groups.set(provider, [])
        }
        groups.get(provider)!.push(model)
    }

    return groupOrder.map((provider) => ({
        provider,
        label: formatProviderLabel(provider),
        models: groups.get(provider)!,
    }))
}

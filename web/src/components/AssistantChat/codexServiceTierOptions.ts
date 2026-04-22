export type CodexComposerServiceTierOption = {
    value: string | null
    label: string
}

const CODEX_SERVICE_TIER_PRESETS = ['fast'] as const
const CODEX_SERVICE_TIER_LABELS: Record<(typeof CODEX_SERVICE_TIER_PRESETS)[number], string> = {
    fast: 'Fast'
}

function normalizeCodexServiceTier(serviceTier?: string | null): string | null {
    const trimmedServiceTier = serviceTier?.trim().toLowerCase()
    if (!trimmedServiceTier || trimmedServiceTier === 'default' || trimmedServiceTier === 'auto') {
        return null
    }

    return trimmedServiceTier
}

function formatCodexServiceTierLabel(serviceTier: string): string {
    return CODEX_SERVICE_TIER_LABELS[serviceTier as keyof typeof CODEX_SERVICE_TIER_LABELS]
        ?? `${serviceTier.charAt(0).toUpperCase()}${serviceTier.slice(1)}`
}

export function getCodexComposerServiceTierOptions(currentServiceTier?: string | null): CodexComposerServiceTierOption[] {
    const normalizedCurrentServiceTier = normalizeCodexServiceTier(currentServiceTier)
    const options: CodexComposerServiceTierOption[] = [
        { value: null, label: 'Default' }
    ]

    if (
        normalizedCurrentServiceTier
        && !CODEX_SERVICE_TIER_PRESETS.includes(normalizedCurrentServiceTier as typeof CODEX_SERVICE_TIER_PRESETS[number])
    ) {
        options.push({
            value: normalizedCurrentServiceTier,
            label: formatCodexServiceTierLabel(normalizedCurrentServiceTier)
        })
    }

    options.push(...CODEX_SERVICE_TIER_PRESETS.map((serviceTier) => ({
        value: serviceTier,
        label: CODEX_SERVICE_TIER_LABELS[serviceTier]
    })))

    return options
}

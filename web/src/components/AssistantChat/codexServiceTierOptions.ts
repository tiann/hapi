export type CodexComposerServiceTierOption = {
    value: string | null
    label: string
}

const CODEX_SERVICE_TIER_PRESETS = ['standard', 'fast'] as const
const CODEX_SERVICE_TIER_LABELS: Record<(typeof CODEX_SERVICE_TIER_PRESETS)[number], string> = {
    standard: 'Standard',
    fast: 'Fast'
}

function normalizeCodexComposerServiceTier(serviceTier?: string | null): string | null {
    const trimmedTier = serviceTier?.trim().toLowerCase()
    if (!trimmedTier || trimmedTier === 'default') {
        return null
    }
    if (trimmedTier === 'priority') {
        return 'fast'
    }

    return trimmedTier
}

function formatCodexServiceTierLabel(serviceTier: string): string {
    return CODEX_SERVICE_TIER_LABELS[serviceTier as keyof typeof CODEX_SERVICE_TIER_LABELS]
        ?? `${serviceTier.charAt(0).toUpperCase()}${serviceTier.slice(1)}`
}

export function getCodexComposerServiceTierOptions(currentServiceTier?: string | null): CodexComposerServiceTierOption[] {
    const normalizedCurrentTier = normalizeCodexComposerServiceTier(currentServiceTier)
    const options: CodexComposerServiceTierOption[] = [
        { value: null, label: 'Default' }
    ]

    options.push(...CODEX_SERVICE_TIER_PRESETS.map((serviceTier) => ({
        value: serviceTier,
        label: CODEX_SERVICE_TIER_LABELS[serviceTier]
    })))

    if (
        normalizedCurrentTier
        && !CODEX_SERVICE_TIER_PRESETS.includes(normalizedCurrentTier as typeof CODEX_SERVICE_TIER_PRESETS[number])
    ) {
        options.push({
            value: normalizedCurrentTier,
            label: formatCodexServiceTierLabel(normalizedCurrentTier)
        })
    }

    return options
}

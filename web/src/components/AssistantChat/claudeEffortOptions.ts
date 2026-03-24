export type ClaudeComposerEffortOption = {
    value: string | null
    label: string
}

const CLAUDE_EFFORT_PRESETS = ['medium', 'high', 'max'] as const
const CLAUDE_EFFORT_LABELS: Record<(typeof CLAUDE_EFFORT_PRESETS)[number], string> = {
    medium: 'Medium',
    high: 'High',
    max: 'Max'
}

function normalizeClaudeComposerEffort(effort?: string | null): string | null {
    const trimmedEffort = effort?.trim().toLowerCase()
    if (!trimmedEffort || trimmedEffort === 'auto' || trimmedEffort === 'default') {
        return null
    }

    return trimmedEffort
}

function formatEffortLabel(effort: string): string {
    return CLAUDE_EFFORT_LABELS[effort as keyof typeof CLAUDE_EFFORT_LABELS]
        ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

export function getClaudeComposerEffortOptions(currentEffort?: string | null): ClaudeComposerEffortOption[] {
    const normalizedCurrentEffort = normalizeClaudeComposerEffort(currentEffort)
    const options: ClaudeComposerEffortOption[] = [
        { value: null, label: 'Auto' }
    ]

    if (
        normalizedCurrentEffort
        && !CLAUDE_EFFORT_PRESETS.includes(normalizedCurrentEffort as typeof CLAUDE_EFFORT_PRESETS[number])
    ) {
        options.push({
            value: normalizedCurrentEffort,
            label: formatEffortLabel(normalizedCurrentEffort)
        })
    }

    options.push(...CLAUDE_EFFORT_PRESETS.map((effort) => ({
        value: effort,
        label: CLAUDE_EFFORT_LABELS[effort]
    })))

    return options
}

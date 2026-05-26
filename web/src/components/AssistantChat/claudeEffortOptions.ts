import {
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_PRESETS,
    formatClaudeEffortLabel
} from '@/lib/claude-effort'

export type ClaudeComposerEffortOption = {
    value: string | null
    label: string
}

function normalizeClaudeComposerEffort(effort?: string | null): string | null {
    const trimmedEffort = effort?.trim().toLowerCase()
    if (!trimmedEffort || trimmedEffort === 'auto' || trimmedEffort === 'default') {
        return null
    }

    return trimmedEffort
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
            label: formatClaudeEffortLabel(normalizedCurrentEffort)
        })
    }

    options.push(...CLAUDE_EFFORT_PRESETS.map((effort) => ({
        value: effort,
        label: CLAUDE_EFFORT_LABELS[effort]
    })))

    return options
}

import { CLAUDE_EFFORT_LABELS, CLAUDE_EFFORT_LEVELS, type ClaudeEffortLevel } from '@hapi/protocol'

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
        && !CLAUDE_EFFORT_LEVELS.includes(normalizedCurrentEffort as ClaudeEffortLevel)
    ) {
        options.push({
            value: normalizedCurrentEffort,
            label: formatEffortLabel(normalizedCurrentEffort)
        })
    }

    options.push(...CLAUDE_EFFORT_LEVELS.map((effort) => ({
        value: effort,
        label: CLAUDE_EFFORT_LABELS[effort]
    })))

    return options
}

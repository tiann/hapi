export const CLAUDE_EFFORT_PRESETS = ['medium', 'high', 'max'] as const

export type ClaudeEffortPreset = (typeof CLAUDE_EFFORT_PRESETS)[number]

export const CLAUDE_EFFORT_LABELS: Record<ClaudeEffortPreset, string> = {
    medium: 'Medium',
    high: 'High',
    max: 'Max'
}

export function formatClaudeEffortLabel(effort: string): string {
    return CLAUDE_EFFORT_LABELS[effort as ClaudeEffortPreset]
        ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

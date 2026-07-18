import {
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_PRESETS,
    getCcApiAutoEffortLabel,
    getCcApiModelEffortPresets,
    getClaudeDeepSeekModelEffortPresets,
} from '@hapi/protocol'

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

export function getClaudeComposerEffortOptions(
    currentEffort?: string | null,
    flavor?: string | null,
    model?: string | null
): ClaudeComposerEffortOption[] {
    const normalizedCurrentEffort = normalizeClaudeComposerEffort(currentEffort)
    if (flavor === 'grok') {
        const values = ['low', 'medium', 'high']
        if (normalizedCurrentEffort && !values.includes(normalizedCurrentEffort)) values.unshift(normalizedCurrentEffort)
        return [{ value: null, label: 'Auto' }, ...values.map((value) => ({ value, label: formatEffortLabel(value) }))]
    }
    if (flavor === 'cc-api') {
        const presets = getCcApiModelEffortPresets(model)
        const options: ClaudeComposerEffortOption[] = [
            { value: null, label: getCcApiAutoEffortLabel(model) }
        ]
        options.push(...presets.map((effort) => ({
            value: effort,
            label: CLAUDE_EFFORT_LABELS[effort]
        })))
        return options
    }
    if (flavor === 'claude-deepseek') {
        return [
            { value: null, label: 'Auto (Claude Code default: Max)' },
            ...getClaudeDeepSeekModelEffortPresets(model).map((effort) => ({
                value: effort,
                label: CLAUDE_EFFORT_LABELS[effort]
            }))
        ]
    }

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

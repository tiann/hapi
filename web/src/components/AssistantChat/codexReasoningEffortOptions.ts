import {
    CODEX_REASONING_EFFORT_LABELS,
    getCodexReasoningEffortsForModel,
} from '@/components/NewSession/types'
import type { CodexReasoningEffort } from '@/components/NewSession/types'

export type CodexComposerReasoningEffortOption = {
    value: string | null
    label: string
}

function normalizeCodexComposerReasoningEffort(effort?: string | null): string | null {
    const trimmedEffort = effort?.trim().toLowerCase()
    if (!trimmedEffort || trimmedEffort === 'default') {
        return null
    }

    return trimmedEffort
}

function formatCodexReasoningEffortLabel(effort: string): string {
    return CODEX_REASONING_EFFORT_LABELS[effort as keyof typeof CODEX_REASONING_EFFORT_LABELS]
        ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

export function getCodexComposerReasoningEffortOptions(currentEffort?: string | null, currentModel?: string | null): CodexComposerReasoningEffortOption[] {
    const normalizedCurrentEffort = normalizeCodexComposerReasoningEffort(currentEffort)
    const presets = getCodexReasoningEffortsForModel(currentModel)
    const options: CodexComposerReasoningEffortOption[] = [
        { value: null, label: 'Default' }
    ]

    if (
        normalizedCurrentEffort
        && !presets.includes(normalizedCurrentEffort as Exclude<CodexReasoningEffort, 'default'>)
    ) {
        options.push({
            value: normalizedCurrentEffort,
            label: formatCodexReasoningEffortLabel(normalizedCurrentEffort)
        })
    }

    options.push(...presets.map((effort) => ({
        value: effort,
        label: CODEX_REASONING_EFFORT_LABELS[effort]
    })))

    return options
}

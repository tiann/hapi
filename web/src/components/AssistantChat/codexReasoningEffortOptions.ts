export type CodexComposerReasoningEffortOption = {
    value: string | null
    label: string
}

export type ComposerReasoningEffortSourceOption = {
    value: string
    name?: string
}

const CODEX_REASONING_EFFORT_PRESETS = ['low', 'medium', 'high', 'xhigh'] as const
const CODEX_REASONING_EFFORT_LABELS: Record<string, string> = {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max',
    ultra: 'Ultra'
}

// DSH advertises a single session-wide `reasoning_effort` config option
// (category thought_level). Its stock deepseek adapter always declares a
// default effort, so the option lists the four explicit levels and never ""
// — sending "" is rejected. The static presets below stand in only until the
// live option arrives; they carry no Default row on purpose.
export const DSH_REASONING_EFFORT_PRESETS = ['off', 'low', 'high', 'max'] as const

/** Source options for SessionChat's dsh picker while the live option is undiscovered. */
export function getDshReasoningEffortSourceOptions(): ComposerReasoningEffortSourceOption[] {
    return DSH_REASONING_EFFORT_PRESETS.map((value) => ({ value }))
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

function buildDynamicReasoningEffortOptions(
    currentEffort: string | null,
    dynamicOptions: ComposerReasoningEffortSourceOption[],
    options: { defaultEntry: boolean } = { defaultEntry: true }
): CodexComposerReasoningEffortOption[] {
    const filteredOptions = dynamicOptions.filter(
        (option) => normalizeCodexComposerReasoningEffort(option.value) !== null
    )
    const optionValues = new Set(filteredOptions.map((option) => option.value))
    const effortOptions: CodexComposerReasoningEffortOption[] = options.defaultEntry
        ? [{ value: null, label: 'Default' }]
        : []

    if (currentEffort && !optionValues.has(currentEffort)) {
        effortOptions.push({
            value: currentEffort,
            label: formatCodexReasoningEffortLabel(currentEffort)
        })
    }

    effortOptions.push(...filteredOptions.map((option) => ({
        value: option.value,
        label: option.name ?? formatCodexReasoningEffortLabel(option.value)
    })))

    return effortOptions
}

export function getCodexComposerReasoningEffortOptions(
    currentEffort?: string | null,
    flavor?: string | null,
    dynamicOptions?: ComposerReasoningEffortSourceOption[] | null
): CodexComposerReasoningEffortOption[] {
    const normalizedCurrentEffort = normalizeCodexComposerReasoningEffort(currentEffort)

    if (flavor === 'opencode') {
        if (!dynamicOptions || dynamicOptions.length === 0) {
            return []
        }
        return buildDynamicReasoningEffortOptions(normalizedCurrentEffort, dynamicOptions)
    }

    if (flavor === 'dsh') {
        // The live list describes the CURRENT model: empty means the model has
        // no thought levels (nothing to pick), undefined means undiscovered
        // (the static presets stand in). dsh's stock adapter always declares a
        // default effort, so "" is not a selectable level and the Default row
        // only exists when the live list actually offers it.
        if (dynamicOptions && dynamicOptions.length === 0) {
            return []
        }
        const sourceOptions = dynamicOptions && dynamicOptions.length > 0
            ? dynamicOptions
            : getDshReasoningEffortSourceOptions()
        return buildDynamicReasoningEffortOptions(normalizedCurrentEffort, sourceOptions, {
            defaultEntry: sourceOptions.some((option) => option.value === '')
        })
    }

    if (dynamicOptions && dynamicOptions.length > 0) {
        return buildDynamicReasoningEffortOptions(normalizedCurrentEffort, dynamicOptions)
    }

    const options: CodexComposerReasoningEffortOption[] = [
        { value: null, label: 'Default' }
    ]

    if (
        normalizedCurrentEffort
        && !(CODEX_REASONING_EFFORT_PRESETS as readonly string[]).includes(normalizedCurrentEffort)
    ) {
        options.push({
            value: normalizedCurrentEffort,
            label: formatCodexReasoningEffortLabel(normalizedCurrentEffort)
        })
    }

    options.push(...CODEX_REASONING_EFFORT_PRESETS.map((effort) => ({
        value: effort,
        label: CODEX_REASONING_EFFORT_LABELS[effort]
    })))

    return options
}

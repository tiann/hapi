export type CodexComposerReasoningEffortOption = {
    value: string | null
    label: string
}

export type ComposerReasoningEffortSourceOption = {
    value: string
    name?: string
}

type CodexReasoningEffortModel = {
    id: string
    isDefault: boolean
    supportedReasoningEfforts?: string[]
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

export function getCodexModelReasoningEffortOptions(
    model: string | null | undefined,
    models: ReadonlyArray<CodexReasoningEffortModel>
): ComposerReasoningEffortSourceOption[] | undefined {
    const normalizedModel = model?.trim().toLowerCase()
    const activeModel = normalizedModel && normalizedModel !== 'auto'
        ? models.find((candidate) => candidate.id.trim().toLowerCase() === normalizedModel)
        : models.find((candidate) => candidate.isDefault)
    const efforts = activeModel?.supportedReasoningEfforts
        ?.map((effort) => effort.trim().toLowerCase())
        .filter(Boolean)

    if (!efforts || efforts.length === 0) {
        return undefined
    }

    return Array.from(new Set(efforts)).map((effort) => ({
        value: effort,
        name: formatCodexReasoningEffortLabel(effort)
    }))
}

function buildDynamicComposerReasoningEffortOptions(
    currentEffort: string | null,
    dynamicOptions: ComposerReasoningEffortSourceOption[]
): CodexComposerReasoningEffortOption[] {
    const optionValues = new Set(dynamicOptions.map((option) => option.value))
    const options: CodexComposerReasoningEffortOption[] = [
        { value: null, label: 'Default' }
    ]

    if (currentEffort && !optionValues.has(currentEffort)) {
        options.push({
            value: currentEffort,
            label: formatCodexReasoningEffortLabel(currentEffort)
        })
    }

    options.push(...dynamicOptions.map((option) => ({
        value: option.value,
        label: option.name ?? formatCodexReasoningEffortLabel(option.value)
    })))

    return options
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
        return buildDynamicComposerReasoningEffortOptions(normalizedCurrentEffort, dynamicOptions)
    }

    if (flavor === 'codex' && dynamicOptions && dynamicOptions.length > 0) {
        return buildDynamicComposerReasoningEffortOptions(normalizedCurrentEffort, dynamicOptions)
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

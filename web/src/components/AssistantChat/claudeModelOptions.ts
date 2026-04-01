import { CLAUDE_MODEL_PRESETS, getClaudeModelLabel } from '@hapi/protocol'

export type ClaudeComposerModelOption = {
    value: string | null
    label: string
}

function normalizeClaudeComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

export function getClaudeComposerModelOptions(currentModel?: string | null): ClaudeComposerModelOption[] {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options: ClaudeComposerModelOption[] = [
        { value: null, label: 'Auto' }
    ]

    if (
        normalizedCurrentModel
        && !CLAUDE_MODEL_PRESETS.includes(normalizedCurrentModel as typeof CLAUDE_MODEL_PRESETS[number])
    ) {
        options.push({
            value: normalizedCurrentModel,
            label: getClaudeModelLabel(normalizedCurrentModel) ?? normalizedCurrentModel
        })
    }

    options.push(...CLAUDE_MODEL_PRESETS.map((model) => ({
        value: model,
        label: getClaudeModelLabel(model) ?? model
    })))

    return options
}

export function getNextClaudeComposerModel(currentModel?: string | null): string | null {
    const normalizedCurrentModel = normalizeClaudeComposerModel(currentModel)
    const options = getClaudeComposerModelOptions(normalizedCurrentModel)
    const currentIndex = options.findIndex((option) => option.value === normalizedCurrentModel)

    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }

    return options[(currentIndex + 1) % options.length]?.value ?? null
}

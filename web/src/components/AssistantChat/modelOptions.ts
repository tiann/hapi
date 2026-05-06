import { MODEL_OPTIONS } from '@/components/NewSession/types'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel } from './claudeModelOptions'
import type { ClaudeComposerModelOption } from './claudeModelOptions'

export type ModelOption = ClaudeComposerModelOption

function normalizeCurrentModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }

    return trimmedModel
}

function withCurrentModelOption(options: ModelOption[], currentModel?: string | null): ModelOption[] {
    const normalizedCurrentModel = normalizeCurrentModel(currentModel)
    if (!normalizedCurrentModel || options.some((option) => option.value === normalizedCurrentModel)) {
        return options
    }

    const nextOptions = [...options]
    const autoIndex = nextOptions.findIndex((option) => option.value === null)
    nextOptions.splice(autoIndex >= 0 ? autoIndex + 1 : 0, 0, {
        value: normalizedCurrentModel,
        label: normalizedCurrentModel
    })
    return nextOptions
}

function getGeminiModelOptions(currentModel?: string | null): ModelOption[] {
    const options = MODEL_OPTIONS.gemini.map((m) => ({
        value: m.value === 'auto' ? null : m.value,
        label: m.label
    }))
    return withCurrentModelOption(options, currentModel)
}

function getNextGeminiModel(currentModel?: string | null): string | null {
    const options = getGeminiModelOptions(currentModel)
    const currentIndex = options.findIndex((o) => o.value === (currentModel ?? null))
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

export function getModelOptionsForFlavor(
    flavor: string | undefined | null,
    currentModel?: string | null,
    customOptions?: ModelOption[]
): ModelOption[] {
    if (customOptions && customOptions.length > 0) {
        return withCurrentModelOption(customOptions, currentModel)
    }
    if (flavor === 'gemini') {
        return getGeminiModelOptions(currentModel)
    }
    // OpenCode discovers models dynamically via the listOpencodeModels RPC. Until
    // those options arrive, render an empty list rather than the Claude fallback —
    // the latter would surface unrelated Claude models in an OpenCode session.
    if (flavor === 'opencode') {
        return []
    }
    return getClaudeComposerModelOptions(currentModel)
}

export function getNextModelForFlavor(
    flavor: string | undefined | null,
    currentModel?: string | null,
    customOptions?: ModelOption[]
): string | null {
    if (customOptions && customOptions.length > 0) {
        const options = getModelOptionsForFlavor(flavor, currentModel, customOptions)
        const currentIndex = options.findIndex((option) => option.value === (normalizeCurrentModel(currentModel) ?? null))
        if (currentIndex === -1) {
            return options.find((option) => option.value !== null)?.value ?? null
        }
        return options[(currentIndex + 1) % options.length]?.value ?? null
    }
    if (flavor === 'gemini') {
        return getNextGeminiModel(currentModel)
    }
    // OpenCode discovers models dynamically via the listOpencodeModels RPC. Until
    // those options arrive, pressing the Ctrl/Cmd+M shortcut must not fall through
    // to the Claude preset cycler — that would post `sonnet`/`opus` into an
    // OpenCode session and the next turn would attempt `session/set_model` with a
    // Claude id. Keep the current model unchanged instead.
    if (flavor === 'opencode') {
        return normalizeCurrentModel(currentModel)
    }
    return getNextClaudeComposerModel(currentModel)
}

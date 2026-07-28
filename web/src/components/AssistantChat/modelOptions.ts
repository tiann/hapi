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

/** Base id before ACP wire suffix, e.g. `claude-opus-4-8[effort=high]` → `claude-opus-4-8`. */
function cursorWireBaseId(modelId: string): string {
    const bracket = modelId.indexOf('[')
    return bracket === -1 ? modelId : modelId.slice(0, bracket)
}

function cursorCatalogCoversCurrentModel(options: ModelOption[], currentModel: string): boolean {
    if (options.some((option) => option.value === currentModel)) {
        return true
    }
    const baseId = cursorWireBaseId(currentModel)
    return options.some((option) => option.value === baseId)
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

function getClaudeModelOptions(currentModel?: string | null, customOptions?: ModelOption[]): ModelOption[] {
    if (!customOptions || customOptions.length === 0) {
        return getClaudeComposerModelOptions(currentModel)
    }

    const options = getClaudeComposerModelOptions(currentModel)
    const nextOptions = [...options]
    let insertIndex = Math.max(1, nextOptions.findIndex((option) => option.value !== null))

    for (const option of customOptions) {
        const normalizedValue = normalizeCurrentModel(option.value)
        if (!normalizedValue) {
            continue
        }

        const existingIndex = nextOptions.findIndex((nextOption) => nextOption.value === normalizedValue)
        if (existingIndex >= 0) {
            if (nextOptions[existingIndex]?.label === normalizedValue) {
                nextOptions[existingIndex] = option
            }
            continue
        }

        nextOptions.splice(insertIndex, 0, {
            value: normalizedValue,
            label: option.label
        })
        insertIndex += 1
    }

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
    if (flavor === 'claude') {
        return getClaudeModelOptions(currentModel, customOptions)
    }
    if (customOptions && customOptions.length > 0) {
        if (flavor === 'cursor') {
            const normalizedCurrent = normalizeCurrentModel(currentModel)
            if (!normalizedCurrent || cursorCatalogCoversCurrentModel(customOptions, normalizedCurrent)) {
                return customOptions
            }
            return withCurrentModelOption(customOptions, currentModel)
        }
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
    if (flavor === 'cursor') {
        return withCurrentModelOption([{ value: null, label: 'Default' }], currentModel)
    }
    // Kimi has no predefined model list — show just the auto/default option.
    if (flavor === 'kimi') {
        return withCurrentModelOption([{ value: null, label: 'Default' }], currentModel)
    }
    if (flavor === 'grok') {
        return withCurrentModelOption([{ value: null, label: 'Default' }], currentModel)
    }
    // Pi model list is provided dynamically via piModels prop in SessionChat,
    // not through this function. Show just the auto/default option here to
    // prevent falling through to the Claude preset cycler (which would
    // surface unrelated Claude models and let set-session-config push
    // `sonnet`/`opus` ids into a Pi session).
    if (flavor === 'pi') {
        return withCurrentModelOption([{ value: null, label: 'Default' }], currentModel)
    }
    return getClaudeModelOptions(currentModel)
}

export function getNextModelForFlavor(
    flavor: string | undefined | null,
    currentModel?: string | null,
    customOptions?: ModelOption[]
): string | null {
    if (flavor === 'claude') {
        const options = getClaudeModelOptions(currentModel, customOptions)
        const currentIndex = options.findIndex((option) => option.value === (normalizeCurrentModel(currentModel) ?? null))
        if (currentIndex === -1) {
            return options[0]?.value ?? null
        }
        return options[(currentIndex + 1) % options.length]?.value ?? null
    }
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
    if (flavor === 'cursor') {
        return normalizeCurrentModel(currentModel)
    }
    if (flavor === 'kimi') {
        return normalizeCurrentModel(currentModel)
    }
    if (flavor === 'grok') {
        return normalizeCurrentModel(currentModel)
    }
    // Pi model list is provided dynamically via piModels prop — pressing
    // Ctrl/Cmd+M must not fall through to the Claude preset cycler.
    if (flavor === 'pi') {
        return normalizeCurrentModel(currentModel)
    }
    return getNextClaudeComposerModel(currentModel)
}

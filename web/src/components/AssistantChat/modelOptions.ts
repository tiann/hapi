import { MODEL_OPTIONS } from '@/components/NewSession/types'
import { getArkModelLabel, getAgyModelLabel, getCcApiModelLabel, getClaudeDeepSeekModelLabel, getHermesMoaPresetLabel } from '@hapi/protocol'
import { getClaudeComposerModelOptions, getNextClaudeComposerModel } from './claudeModelOptions'
import type { ClaudeComposerModelOption } from './claudeModelOptions'

export type ModelOption = ClaudeComposerModelOption

function getClaudeDeepSeekModelOptions(_currentModel?: string | null): ModelOption[] {
    return MODEL_OPTIONS['claude-deepseek'].map((m) => ({
        value: m.value,
        label: getClaudeDeepSeekModelLabel(m.value) ?? m.label
    }))
}

function getNextClaudeDeepSeekModel(currentModel?: string | null): string | null {
    const options = getClaudeDeepSeekModelOptions(currentModel)
    const normalized = currentModel?.trim() || null
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

function getAgyModelOptions(_currentModel?: string | null): ModelOption[] {
    return MODEL_OPTIONS.agy.map((m) => ({
        value: m.value,
        label: getAgyModelLabel(m.value) ?? m.label
    }))
}

function getNextAgyModel(currentModel?: string | null): string | null {
    const options = getAgyModelOptions(currentModel)
    const normalized = currentModel?.trim() || null
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

function getGrokModelOptions(currentModel?: string | null, availableModels?: Array<{ id: string; name: string }>): ModelOption[] {
    const source = availableModels?.length
        ? [{ id: 'auto', name: 'Auto' }, ...availableModels]
        : MODEL_OPTIONS.grok.map((model) => ({ id: model.value, name: model.label }))
    const options = source.map((m) => ({ value: m.id === 'auto' ? null : m.id, label: m.name }))
    const normalized = currentModel?.trim() || null
    if (normalized && !options.some((option) => option.value === normalized)) {
        options.splice(1, 0, { value: normalized, label: normalized })
    }
    return options
}

function getNextGrokModel(currentModel?: string | null, availableModels?: Array<{ id: string; name: string }>): string | null {
    const options = getGrokModelOptions(currentModel, availableModels)
    const normalized = currentModel?.trim() || null
    const index = options.findIndex((option) => option.value === normalized)
    return options[index === -1 ? 0 : (index + 1) % options.length]?.value ?? null
}

function getArkModelOptions(currentModel?: string | null): ModelOption[] {
    const options = MODEL_OPTIONS['claude-ark'].map((m) => ({
        value: m.value,
        label: m.label
    }))
    const normalized = currentModel?.trim() || null
    if (normalized && !options.some((o) => o.value === normalized)) {
        options.splice(0, 0, {
            value: normalized,
            label: getArkModelLabel(normalized) ?? normalized
        })
    }
    return options
}

function getNextArkModel(currentModel?: string | null): string | null {
    const options = getArkModelOptions(currentModel)
    const normalized = currentModel?.trim() || null
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}


function getCcApiModelOptions(currentModel?: string | null): ModelOption[] {
    const options = MODEL_OPTIONS['cc-api'].map((m) => ({
        value: m.value,
        label: m.label
    }))
    const normalized = currentModel?.trim() || null
    if (normalized && !options.some((o) => o.value === normalized)) {
        options.splice(0, 0, {
            value: normalized,
            label: getCcApiModelLabel(normalized) ?? normalized
        })
    }
    return options
}

function getNextCcApiModel(currentModel?: string | null): string | null {
    const options = getCcApiModelOptions(currentModel)
    const normalized = currentModel?.trim() || null
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

function getHermesMoaModelOptions(_currentModel?: string | null): ModelOption[] {
    return MODEL_OPTIONS['hermes-moa'].map((m) => ({
        value: m.value,
        label: getHermesMoaPresetLabel(m.value) ?? m.label
    }))
}

function getNextHermesMoaModel(currentModel?: string | null): string | null {
    const options = getHermesMoaModelOptions(currentModel)
    const normalized = currentModel?.trim() || null
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

function normalizeCodexComposerModel(model?: string | null): string | null {
    const trimmedModel = model?.trim()
    if (!trimmedModel || trimmedModel === 'auto' || trimmedModel === 'default') {
        return null
    }
    return trimmedModel
}

function getCodexModelOptions(currentModel?: string | null): ModelOption[] {
    const normalizedCurrentModel = normalizeCodexComposerModel(currentModel)
    const options = MODEL_OPTIONS.codex.map((m) => ({
        value: m.value === 'auto' ? null : m.value,
        label: m.label
    }))
    if (normalizedCurrentModel && !options.some((o) => o.value === normalizedCurrentModel)) {
        options.splice(1, 0, {
            value: normalizedCurrentModel,
            label: normalizedCurrentModel
        })
    }
    return options
}

function getNextCodexModel(currentModel?: string | null): string | null {
    const options = getCodexModelOptions(currentModel)
    const normalized = normalizeCodexComposerModel(currentModel)
    const currentIndex = options.findIndex((o) => o.value === normalized)
    if (currentIndex === -1) {
        return options[0]?.value ?? null
    }
    return options[(currentIndex + 1) % options.length]?.value ?? null
}

export function getModelOptionsForFlavor(flavor: string | undefined | null, currentModel?: string | null, availableModels?: Array<{ id: string; name: string }>): ModelOption[] {
    if (flavor === 'codex') {
        return getCodexModelOptions(currentModel)
    }
    if (flavor === 'claude-ark') {
        return getArkModelOptions(currentModel)
    }
    if (flavor === 'claude-deepseek') {
        return getClaudeDeepSeekModelOptions(currentModel)
    }
    if (flavor === 'cc-api') {
        return getCcApiModelOptions(currentModel)
    }
    if (flavor === 'agy') {
        return getAgyModelOptions(currentModel)
    }
    if (flavor === 'grok') {
        return getGrokModelOptions(currentModel, availableModels)
    }
    if (flavor === 'hermes-moa') {
        return getHermesMoaModelOptions(currentModel)
    }
    return getClaudeComposerModelOptions(currentModel)
}

export function getNextModelForFlavor(
    flavor: string | undefined | null,
    currentModel?: string | null,
    availableModels?: Array<{ id: string; name: string }>
): string | null {
    if (flavor === 'codex') {
        return getNextCodexModel(currentModel)
    }
    if (flavor === 'claude-ark') {
        return getNextArkModel(currentModel)
    }
    if (flavor === 'claude-deepseek') {
        return getNextClaudeDeepSeekModel(currentModel)
    }
    if (flavor === 'cc-api') {
        return getNextCcApiModel(currentModel)
    }
    if (flavor === 'agy') {
        return getNextAgyModel(currentModel)
    }
    if (flavor === 'grok') {
        return getNextGrokModel(currentModel, availableModels)
    }
    if (flavor === 'hermes-moa') {
        return getNextHermesMoaModel(currentModel)
    }
    return getNextClaudeComposerModel(currentModel)
}

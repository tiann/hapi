import { MODEL_OPTIONS } from '@/components/NewSession/types'
import { CURSOR_AUTO_MODEL_LABEL } from '@/lib/cursorModelOptions'
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

/**
 * Every Claude options list must carry the null "use the session default" row:
 * HappyComposer renders it as the Default entry and it is the only way to unpin
 * a model. getClaudeComposerModelOptions guarantees it, but a caller passing a
 * raw catalog array (or a test fixture) may not.
 */
function withClaudeDefaultRow(options: ModelOption[]): ModelOption[] {
    return options.some((option) => option.value === null)
        ? options
        : [{ value: null, label: 'Default' }, ...options]
}

function getAgyModelOptions(currentModel?: string | null): ModelOption[] {
    const options = MODEL_OPTIONS.agy.filter((m) => m.value !== 'auto').map((m) => ({
        value: m.value,
        label: m.label
    }))
    return withCurrentModelOption(options, currentModel)
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
    if (flavor === 'agy') {
        return getAgyModelOptions(currentModel)
    }
    // Claude trusts a supplied catalog as-is instead of going through the
    // generic customOptions branch below. That branch's withCurrentModelOption
    // only compares raw wire values, so a session storing a *resolved* SDK id
    // (e.g. "claude-opus-5[1m]") would not match the catalog's "opus[1m]" row
    // and would get a second, worse-labeled row spliced in -- exactly the
    // duplicate this PR removes. getClaudeComposerModelOptions already did the
    // resolvedModel-aware dedup when SessionChat.tsx built this array (or, with
    // no catalog, builds the static-fallback + explicit-current-model list
    // itself), so re-running it through withCurrentModelOption here would
    // silently undo that.
    if (flavor === 'claude') {
        return withClaudeDefaultRow(
            customOptions && customOptions.length > 0
                ? customOptions
                : getClaudeComposerModelOptions(currentModel)
        )
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
        return withCurrentModelOption([{ value: null, label: CURSOR_AUTO_MODEL_LABEL }], currentModel)
    }
    // Kimi has no predefined model list — show just the auto/default option.
    if (flavor === 'kimi') {
        return withCurrentModelOption([{ value: null, label: 'Default' }], currentModel)
    }
    if (flavor === 'copilot') {
        if (customOptions && customOptions.length > 0) {
            return withCurrentModelOption(customOptions, currentModel)
        }
        return withCurrentModelOption([{ value: null, label: 'Auto' }], currentModel)
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
    // Unreachable for 'claude' (handled above) and every other known flavor;
    // kept as a defensive fallback for any future/unlisted flavor value.
    return getClaudeComposerModelOptions(currentModel)
}

export function getNextModelForFlavor(
    flavor: string | undefined | null,
    currentModel?: string | null,
    customOptions?: ModelOption[]
): string | null {
    if (flavor === 'agy') {
        const options = getAgyModelOptions(currentModel)
        const currentIndex = options.findIndex((option) => option.value === (normalizeCurrentModel(currentModel) ?? null))
        if (currentIndex === -1) {
            return options.find((option) => option.value !== null)?.value ?? null
        }
        return options[(currentIndex + 1) % options.length]?.value ?? null
    }
    // Mirrors getModelOptionsForFlavor's claude branch: trust a supplied
    // catalog as-is (already resolvedModel-deduped) instead of the generic
    // customOptions branch below, which would re-derive an options array via
    // getModelOptionsForFlavor -> withCurrentModelOption and reintroduce the
    // duplicate-row bug described there.
    if (flavor === 'claude') {
        const options = withClaudeDefaultRow(
            customOptions && customOptions.length > 0
                ? customOptions
                : getClaudeComposerModelOptions(currentModel)
        )
        const currentIndex = options.findIndex((option) => option.value === (normalizeCurrentModel(currentModel) ?? null))
        if (currentIndex === -1) {
            // Matches agy/the generic customOptions branch below: land on the
            // first *concrete* model, not options[0] (which is the null
            // "Default" row) -- otherwise a not-found current model (e.g. the
            // caller passed a raw resolved SDK id instead of the catalog's
            // own wire value) makes a single Ctrl/Cmd+M press silently clear
            // the pinned model instead of advancing to the next one.
            return options.find((option) => option.value !== null)?.value ?? null
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
    if (flavor === 'copilot') {
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

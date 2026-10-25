import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_PRESETS, PI_THINKING_LEVELS, type ResolvedChatCreation } from '@hapi/protocol'
import type { SyncEngine } from './syncEngine'

/** Validate against the same runner catalogs used by New Chat before spawning. */
export async function validateChatCreation(engine: SyncEngine, options: ResolvedChatCreation): Promise<void> {
    const { agent, machineId, directory, model, effort, modelReasoningEffort } = options
    const availability = await engine.getAgentAvailability(machineId)
    if (!availability.agents?.some(item => item.agent === agent && item.available)) throw new Error(`${agent} is unavailable on the selected runner`)
    const customModel = model && model !== 'auto' ? model : null
    if (agent === 'claude') {
        if (customModel && !(CLAUDE_MODEL_PRESETS as readonly string[]).includes(customModel)) throw new Error(`Unsupported Claude model ${customModel}`)
        if (effort && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort)) throw new Error(`Unsupported Claude effort ${effort}`)
        return
    }
    if (agent === 'codex' && (customModel || modelReasoningEffort || options.serviceTier === 'fast')) {
        const catalog = await engine.listCodexModelsForMachine(machineId)
        if (!catalog.success) throw new Error(catalog.error ?? 'Codex models unavailable')
        const selected = customModel ? catalog.models?.find(m => m.id === customModel) : catalog.models?.find(m => m.isDefault)
        if (!selected) throw new Error('Selected Codex model is unavailable')
        if (modelReasoningEffort && !selected.supportedReasoningEfforts?.includes(modelReasoningEffort)) throw new Error('Reasoning effort is unsupported by this Codex model')
        if (options.serviceTier === 'fast' && !selected.serviceTiers?.includes('fast')) throw new Error('Fast service tier is unavailable for this Codex model')
        return
    }
    if (agent === 'pi' && (customModel || effort)) {
        const catalog = await engine.listPiModelsForMachine(machineId)
        if (!catalog.success) throw new Error(catalog.error ?? 'Pi models unavailable')
        const selected = customModel ? catalog.availableModels?.find(m => `${m.provider || 'unknown'}/${m.modelId}` === customModel) : undefined
        if (customModel && !selected) throw new Error('Selected Pi model is unavailable')
        if (effort && (!(PI_THINKING_LEVELS as readonly string[]).includes(effort)
            || selected?.thinkingLevelMap?.[effort] === null
            || (['xhigh', 'max'].includes(effort) && selected?.thinkingLevelMap?.[effort] == null))) throw new Error('Thinking level is unsupported by this Pi model')
        return
    }
    if (agent === 'grok' && (customModel || effort || options.permissionMode === 'auto')) {
        const catalog = await engine.listGrokModelsForCwd(machineId, directory)
        if (!catalog.success) throw new Error(catalog.error ?? 'Grok models unavailable')
        const selected = customModel ? catalog.availableModels?.find(m => m.modelId === customModel) : catalog.availableModels?.find(m => m.modelId === catalog.currentModelId)
        if (customModel && !selected) throw new Error('Selected Grok model is unavailable')
        if (effort && !selected?.reasoningEfforts?.some(e => e.value === effort)) throw new Error('Effort is unsupported by this Grok model')
        if (options.permissionMode === 'auto' && !catalog.autoPermissionModeSupported) throw new Error('Grok Auto permission is unavailable')
        return
    }
    if (agent === 'opencode' && (customModel || modelReasoningEffort)) {
        const catalog = await engine.listOpencodeModelsForCwd(machineId, directory)
        if (!catalog.success) throw new Error(catalog.error ?? 'OpenCode models unavailable')
        if (customModel && !catalog.availableModels?.some(m => m.modelId === customModel)) throw new Error('Selected OpenCode model is unavailable')
        if (modelReasoningEffort) {
            const variants = await engine.listOpencodeModelVariantsForMachine(machineId, directory)
            const selected = customModel ?? catalog.currentModelId
            if (!variants.success || !selected || !variants.variants?.[selected]?.includes(modelReasoningEffort)) throw new Error('Reasoning effort is unsupported by this OpenCode model')
        }
        return
    }
    if (!customModel) return
    if (agent === 'cursor') {
        const catalog = await engine.listCursorModelsForMachine(machineId)
        if (!catalog.success || ![...(catalog.availableModels ?? []), ...(catalog.cliModelSkus ?? [])].some(m => m.modelId === customModel)) throw new Error('Selected Cursor model is unavailable')
        return
    }
    const catalog = agent === 'agy' ? await engine.listAgyModelsForMachine(machineId)

        : agent === 'copilot' ? await engine.listCopilotModelsForCwd(machineId, directory)
            : agent === 'kimi' ? await engine.listKimiModelsForCwd(machineId, directory) : null
    if (catalog && (!catalog.success || !catalog.availableModels?.some(m => m.modelId === customModel))) throw new Error(`Selected ${agent} model is unavailable`)
}

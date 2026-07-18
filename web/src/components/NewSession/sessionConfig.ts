import { DEFAULT_AGY_MODEL, DEFAULT_ARK_MODEL, DEFAULT_CC_API_MODEL, DEFAULT_CLAUDE_DEEPSEEK_MODEL, DEFAULT_HERMES_MOA_PRESET, isCcApiEffortAllowedForModel, isClaudeDeepSeekEffortAllowedForModel } from '@hapi/protocol'
import type { AgentType, ClaudeEffort } from './types'
import type { PermissionMode } from '@/types/api'

export type SpawnModelConfigInput = {
    agent: AgentType
    model: string
    effort: ClaudeEffort
}

export type SpawnModelConfig = {
    model?: string
    effort?: string
}

export function resolveSpawnPermissionConfig(
    agent: AgentType,
    permissionMode: PermissionMode,
    yolo: boolean
): { permissionMode?: PermissionMode; yolo?: boolean } {
    const usesSelector = agent === 'agy' || agent === 'grok' || agent === 'hermes-moa'
    return usesSelector
        ? { permissionMode: permissionMode === 'default' ? undefined : permissionMode, yolo: undefined }
        : { permissionMode: undefined, yolo }
}

export function getDefaultModelForAgent(agent: AgentType): string {
    if (agent === 'claude-deepseek') {
        return DEFAULT_CLAUDE_DEEPSEEK_MODEL
    }
    if (agent === 'claude-ark') {
        return DEFAULT_ARK_MODEL
    }
    if (agent === 'cc-api') {
        return DEFAULT_CC_API_MODEL
    }
    if (agent === 'agy') {
        return DEFAULT_AGY_MODEL
    }
    if (agent === 'hermes-moa') {
        return DEFAULT_HERMES_MOA_PRESET
    }

    return 'auto'
}

export function resolveSpawnModelConfig(input: SpawnModelConfigInput): SpawnModelConfig {
    const model = input.agent === 'claude-deepseek'
        ? input.model === 'auto' ? DEFAULT_CLAUDE_DEEPSEEK_MODEL : input.model
        : input.agent === 'claude-ark'
        ? input.model === 'auto' ? DEFAULT_ARK_MODEL : input.model
        : input.agent === 'cc-api'
            ? input.model === 'auto' ? DEFAULT_CC_API_MODEL : input.model
        : input.agent === 'agy'
            ? input.model === 'auto' ? DEFAULT_AGY_MODEL : input.model
        : input.agent === 'hermes-moa'
            ? input.model === 'auto' ? DEFAULT_HERMES_MOA_PRESET : input.model
        : input.model !== 'auto' && input.agent !== 'opencode'
            ? input.model
            : undefined
    const effort = input.agent === 'grok' && input.effort !== 'auto'
        ? input.effort
        : (input.agent === 'claude' || input.agent === 'claude-deepseek' || input.agent === 'claude-ark' || input.agent === 'cc-api') && input.effort !== 'auto'
            && (input.agent !== 'cc-api' || isCcApiEffortAllowedForModel(model, input.effort))
            && (input.agent !== 'claude-deepseek' || isClaudeDeepSeekEffortAllowedForModel(model, input.effort))
            ? input.effort
            : undefined

    return { model, effort }
}

import { z } from 'zod'
import { SpawnSessionRequestSchema } from './apiTypes'
import { CREATABLE_AGENT_FLAVORS, getLaunchPermissionModesForFlavor } from './modes'
import { resolveHapiYoloPermissionMode } from './agentConfig'

// Null explicitly requests the product/native default; absence inherits.
export const ChatLaunchSettingsSchema = SpawnSessionRequestSchema.omit({ directory: true, agent: true })
    .extend({
        model: z.string().trim().min(1).nullable().optional(),
        effort: z.string().trim().min(1).nullable().optional(),
        modelReasoningEffort: z.string().trim().min(1).nullable().optional(),
        permissionMode: SpawnSessionRequestSchema.shape.permissionMode.unwrap().nullable().optional(),
        serviceTier: SpawnSessionRequestSchema.shape.serviceTier.unwrap().nullable().optional(),
        collaborationMode: SpawnSessionRequestSchema.shape.collaborationMode.unwrap().nullable().optional(),
        copilotAgentMode: SpawnSessionRequestSchema.shape.copilotAgentMode.unwrap().nullable().optional(),
        worktreeName: z.string().trim().min(1).nullable().optional(),
        yolo: z.boolean().nullable().optional(),
        startingMode: SpawnSessionRequestSchema.shape.startingMode.unwrap().nullable().optional()
    }).strict()
export type ChatLaunchSettings = z.infer<typeof ChatLaunchSettingsSchema>
export const ChatCreationOverridesSchema = ChatLaunchSettingsSchema.extend({
    machineId: z.string().trim().min(1).optional(),
    directory: z.string().trim().min(1).optional(),
    agent: SpawnSessionRequestSchema.shape.agent,
}).strict()
export type ChatCreationOverrides = z.infer<typeof ChatCreationOverridesSchema>
export const ChatCreationPreferencesSchema = z.object({
    lastMachineId: z.string().optional(),
    lastAgent: SpawnSessionRequestSchema.shape.agent,
    machines: z.record(z.string(), z.object({
        directory: z.string().optional(),
        agents: z.record(z.string(), ChatLaunchSettingsSchema)
    }).strict())
}).strict()
export type ChatCreationPreferences = z.infer<typeof ChatCreationPreferencesSchema>
export type ResolvedChatCreation = ChatLaunchSettings & {
    machineId: string
    directory: string
    agent: NonNullable<ChatCreationOverrides['agent']>
    sessionType: 'simple' | 'worktree'
}

export function resolveChatCreation(
    overrides: ChatCreationOverrides,
    preferences: ChatCreationPreferences,
    onlineMachineIds: string[]
): ResolvedChatCreation {
    const machineId = overrides.machineId ?? (onlineMachineIds.includes(preferences.lastMachineId ?? '') ? preferences.lastMachineId : onlineMachineIds[0])
    if (!machineId || !onlineMachineIds.includes(machineId)) throw new Error('Selected machine is unavailable; choose an online machineId')
    const agent = overrides.agent ?? preferences.lastAgent ?? 'claude'
    if (!CREATABLE_AGENT_FLAVORS.includes(agent)) throw new Error(`Agent ${agent} cannot create new chats`)
    const machine = preferences.machines[machineId]
    const directory = overrides.directory ?? machine?.directory
    if (!directory?.trim()) throw new Error('A directory is required when no saved directory exists')
    const { machineId: _machine, directory: _directory, agent: _agent, ...explicit } = overrides
    const result: ResolvedChatCreation = {
        sessionType: 'simple', ...machine?.agents[agent], ...explicit, machineId, directory, agent
    }
    // Permission and YOLO are two representations of one decision. An explicit
    // value must replace the other representation rather than inherit a conflict.
    if (Object.hasOwn(explicit, 'permissionMode') && !Object.hasOwn(explicit, 'yolo')) result.yolo = false
    if (Object.hasOwn(explicit, 'yolo') && !Object.hasOwn(explicit, 'permissionMode')
        && (explicit.yolo === true || result.permissionMode === resolveHapiYoloPermissionMode(agent))) result.permissionMode = null
    if (result.permissionMode && !getLaunchPermissionModesForFlavor(agent).includes(result.permissionMode)) {
        throw new Error(`Unsupported permission mode ${result.permissionMode} for ${agent}`)
    }
    if (result.yolo && result.permissionMode && result.permissionMode !== resolveHapiYoloPermissionMode(agent)) {
        throw new Error('yolo and permissionMode conflict')
    }
    if (result.yolo && !resolveHapiYoloPermissionMode(agent)) throw new Error(`${agent} manages its own permissions`)
    const only = (field: keyof ChatLaunchSettings, agents: string[]) => {
        if (result[field] !== undefined && result[field] !== null && !agents.includes(agent)) {
            throw new Error(`${field} is unsupported for ${agent}; clear it or choose a supported agent`)
        }
    }
    only('serviceTier', ['codex'])
    only('collaborationMode', ['codex'])
    only('copilotAgentMode', ['copilot'])
    only('modelReasoningEffort', ['codex', 'opencode'])
    only('effort', ['claude', 'grok', 'pi'])
    if (agent === 'dsh' && result.model) throw new Error('DSH does not support a model override')
    if (['agy', 'dsh'].includes(agent) && result.startingMode && result.startingMode !== 'remote') throw new Error(`${agent} only supports remote mode`)
    if (result.sessionType !== 'worktree') {
        if (explicit.worktreeName) throw new Error('worktreeName requires worktree sessionType')
        result.worktreeName = null
    }
    return result
}

export function rememberChatCreation(preferences: ChatCreationPreferences, resolved: ResolvedChatCreation): ChatCreationPreferences {
    const { machineId, directory, agent, ...settings } = resolved
    const machine = preferences.machines[machineId]
    return {
        ...preferences, lastMachineId: machineId, lastAgent: agent,
        machines: {
            ...preferences.machines,
            [machineId]: { directory, agents: { ...machine?.agents, [agent]: settings } }
        }
    }
}

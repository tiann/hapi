import { z } from 'zod'
import { CODEX_PERMISSION_MODES } from './modes'
import { CodexCollaborationModeSchema } from './schemas'

export const SESSION_PROFILE_REASONING_EFFORT_VALUES = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export const SessionProfileAgentSchema = z.literal('codex')
export const SessionProfileReasoningEffortSchema = z.enum(SESSION_PROFILE_REASONING_EFFORT_VALUES)
export const SessionProfilePermissionModeSchema = z.enum(CODEX_PERMISSION_MODES)

export const SessionProfileDefaultsSchema = z.object({
    model: z.string().optional(),
    modelReasoningEffort: SessionProfileReasoningEffortSchema.optional(),
    permissionMode: SessionProfilePermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    sessionType: z.enum(['simple', 'worktree']).optional()
})

export const SessionProfileSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    agent: SessionProfileAgentSchema,
    defaults: SessionProfileDefaultsSchema
})

export const MachineSessionProfilesDefaultsSchema = z.object({
    codexProfileId: z.string().nullable().optional()
})

export const MachineSessionProfilesSchema = z.object({
    profiles: z.array(SessionProfileSchema),
    defaults: MachineSessionProfilesDefaultsSchema
})

export type SessionProfileAgent = z.infer<typeof SessionProfileAgentSchema>
export type SessionProfileReasoningEffort = z.infer<typeof SessionProfileReasoningEffortSchema>
export type SessionProfilePermissionMode = z.infer<typeof SessionProfilePermissionModeSchema>
export type SessionProfileDefaults = z.infer<typeof SessionProfileDefaultsSchema>
export type SessionProfile = z.infer<typeof SessionProfileSchema>
export type MachineSessionProfilesDefaults = z.infer<typeof MachineSessionProfilesDefaultsSchema>
export type MachineSessionProfiles = z.infer<typeof MachineSessionProfilesSchema>

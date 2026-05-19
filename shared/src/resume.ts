import { z } from 'zod'
import { CodexCollaborationModeSchema, PermissionModeSchema } from './schemas'

export const AgentFlavorSchema = z.enum(['claude', 'codex', 'gemini', 'opencode', 'cursor'])

export const LocalResumeTargetSchema = z.object({
    sessionId: z.string().min(1),
    flavor: AgentFlavorSchema,
    directory: z.string().min(1),
    machineId: z.string().optional(),
    host: z.string().optional(),
    active: z.boolean(),
    thinking: z.boolean(),
    controlledByUser: z.boolean(),
    agentSessionId: z.string().min(1),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    modelReasoningEffort: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional()
})

export type LocalResumeTarget = z.infer<typeof LocalResumeTargetSchema>

export const ResumableSessionSchema = LocalResumeTargetSchema.extend({
    updatedAt: z.number(),
    name: z.string().optional(),
    summary: z.string().optional()
})

export type ResumableSession = z.infer<typeof ResumableSessionSchema>

export const LocalResumeTargetResponseSchema = z.object({
    target: LocalResumeTargetSchema
})

export type LocalResumeTargetResponse = z.infer<typeof LocalResumeTargetResponseSchema>

export const ResumableSessionsResponseSchema = z.object({
    sessions: z.array(ResumableSessionSchema)
})

export type ResumableSessionsResponse = z.infer<typeof ResumableSessionsResponseSchema>

export const LocalHandoffResponseSchema = z.object({
    ok: z.boolean()
})

export type LocalHandoffResponse = z.infer<typeof LocalHandoffResponseSchema>

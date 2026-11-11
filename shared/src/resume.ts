import { z } from 'zod'
import { CodexCollaborationModeSchema, CopilotAgentModeSchema, PermissionModeSchema } from './schemas'
import { AgentFlavorSchema } from './modes'

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
    serviceTier: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional()
})

export type LocalResumeTarget = z.infer<typeof LocalResumeTargetSchema>

export const ResumableSessionSchema = LocalResumeTargetSchema.extend({
    updatedAt: z.number(),
    name: z.string().optional(),
    summary: z.string().optional(),
    firstUserMessage: z.string().optional()
})

export type ResumableSession = z.infer<typeof ResumableSessionSchema>

export const LocalResumeTargetResponseSchema = z.object({
    target: LocalResumeTargetSchema
})

export type LocalResumeTargetResponse = z.infer<typeof LocalResumeTargetResponseSchema>

/**
 * Lookup of the HAPI session that owns a native agent session id.
 * `target: null` means no HAPI session owns it (start a fresh one).
 * `historical: true` means the id matched an earlier, rotated-away native id;
 * `target.agentSessionId` is then the owner's current native id.
 */
export const LocalResumeTargetByAgentResponseSchema = z.object({
    target: LocalResumeTargetSchema.nullable(),
    historical: z.boolean().optional()
})

export type LocalResumeTargetByAgentResponse = z.infer<typeof LocalResumeTargetByAgentResponseSchema>

export const ResumableSessionsResponseSchema = z.object({
    sessions: z.array(ResumableSessionSchema)
})

export type ResumableSessionsResponse = z.infer<typeof ResumableSessionsResponseSchema>

export const LocalHandoffResponseSchema = z.object({
    ok: z.boolean()
})

export type LocalHandoffResponse = z.infer<typeof LocalHandoffResponseSchema>

/** `POST /cli/sessions/:id/prepare-local-resume`; `revived` = a hub archive was cleared. */
export const LocalResumePrepareResponseSchema = z.object({
    ok: z.boolean(),
    revived: z.boolean().optional()
})

export type LocalResumePrepareResponse = z.infer<typeof LocalResumePrepareResponseSchema>

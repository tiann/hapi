import { z } from 'zod'
import { CodexCollaborationModeSchema, CopilotAgentModeSchema, PermissionModeSchema } from './schemas'
import { AgentFlavorSchema } from './modes'

const resumeTargetFields = {
    sessionId: z.string().min(1),
    flavor: AgentFlavorSchema,
    directory: z.string().min(1),
    machineId: z.string().optional(),
    host: z.string().optional(),
    active: z.boolean(),
    thinking: z.boolean(),
    controlledByUser: z.boolean(),
    // A Reasonix session/new may have an allocated native id that is not yet
    // persisted. Such a status-only row is intentionally fresh-started and
    // therefore has no native resume token.
    agentSessionId: z.string().min(1).optional(),
    /** True when the native id was allocated but no transcript exists yet. */
    freshStart: z.boolean().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    modelReasoningEffort: z.string().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    permissionMode: PermissionModeSchema.optional(),
    collaborationMode: CodexCollaborationModeSchema.optional(),
    copilotAgentMode: CopilotAgentModeSchema.optional()
} as const

function requireResumeTokenUnlessReasonixFreshStart(
    value: { flavor: string; freshStart?: boolean; agentSessionId?: string },
    context: z.RefinementCtx
): void {
    if (value.freshStart === true && value.flavor !== 'reasonix') {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['freshStart'],
            message: 'freshStart is only supported for Reasonix targets'
        })
    }
    if (!value.agentSessionId && !(value.flavor === 'reasonix' && value.freshStart === true)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agentSessionId'],
            message: 'agentSessionId is required unless this is a fresh Reasonix start'
        })
    }
}

export const LocalResumeTargetSchema = z.object(resumeTargetFields).superRefine(
    requireResumeTokenUnlessReasonixFreshStart
)

export type LocalResumeTarget = z.infer<typeof LocalResumeTargetSchema>

export const ResumableSessionSchema = z.object({ ...resumeTargetFields,
    updatedAt: z.number(),
    name: z.string().optional(),
    summary: z.string().optional(),
    firstUserMessage: z.string().optional()
}).superRefine(requireResumeTokenUnlessReasonixFreshStart)

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

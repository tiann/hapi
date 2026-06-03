import {
    AgentStateSchema,
    AttachmentMetadataSchema,
    MachineMetadataSchema,
    MetadataSchema,
    RunnerStateSchema
} from '@hapi/protocol/schemas'
import {
    CliMessagesResponseSchema,
    CreateMachineResponseSchema,
    CreateSessionResponseSchema,
    GetSessionResponseSchema,
    LocalHandoffResponseSchema,
    LocalResumeTargetResponseSchema,
    ResumableSessionsResponseSchema,
    type CliMessagesResponse,
    type CreateMachineResponse,
    type CreateSessionResponse,
    type GetSessionResponse
} from '@hapi/protocol'
import type { CodexCollaborationMode, Machine, MachineMetadata, PermissionMode, RunnerState } from '@hapi/protocol/types'
import { z } from 'zod'
import { UsageSchema } from '@/claude/types'

export type Usage = z.infer<typeof UsageSchema>

export type {
    AgentState,
    AttachmentMetadata,
    ClaudePermissionMode,
    CodexCollaborationMode,
    CodexPermissionMode,
    Machine,
    MachineMetadata,
    Metadata,
    RunnerState,
    Session
} from '@hapi/protocol/types'
export type SessionPermissionMode = PermissionMode
export type SessionCollaborationMode = CodexCollaborationMode
export type SessionModel = string | null
export type SessionModelReasoningEffort = string | null
export type SessionEffort = string | null
export type SessionServiceTier = string | null

export { AgentStateSchema, AttachmentMetadataSchema, MachineMetadataSchema, MetadataSchema, RunnerStateSchema }

export {
    CliMessagesResponseSchema,
    CreateMachineResponseSchema,
    CreateSessionResponseSchema,
    GetSessionResponseSchema,
    LocalHandoffResponseSchema,
    LocalResumeTargetResponseSchema,
    ResumableSessionsResponseSchema
}

export type {
    CliMessagesResponse,
    CreateMachineResponse,
    CreateSessionResponse,
    GetSessionResponse
}

export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional()
})

export type MessageMeta = z.infer<typeof MessageMetaSchema>

export const UserMessageSchema = z.object({
    role: z.literal('user'),
    content: z.object({
        type: z.literal('text'),
        text: z.string(),
        attachments: z.array(AttachmentMetadataSchema).optional()
    }),
    localKey: z.string().optional(),
    meta: MessageMetaSchema.optional()
})

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
    role: z.literal('agent'),
    content: z.object({
        type: z.literal('output'),
        data: z.unknown()
    }),
    meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

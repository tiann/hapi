import {
    AgentStateSchema,
    AttachmentMetadataSchema,
    CodexCollaborationModeSchema,
    CodexServiceTierSchema,
    MachineMetadataSchema,
    MetadataSchema,
    PermissionModeSchema,
    TodosSchema
} from '@hapi/protocol/schemas'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { CodexCollaborationMode, CodexServiceTier, MachineMetadata as ProtocolMachineMetadata, PermissionMode } from '@hapi/protocol/types'
import { z } from 'zod'
import { UsageSchema } from '@/claude/types'

export type Usage = z.infer<typeof UsageSchema>

export type {
    AgentState,
    AttachmentMetadata,
    ClaudePermissionMode,
    CodexCollaborationMode,
    CodexPermissionMode,
    Metadata,
    Session
} from '@hapi/protocol/types'
export type SessionPermissionMode = PermissionMode
export type SessionCollaborationMode = CodexCollaborationMode
export type SessionModel = string | null
export type SessionModelReasoningEffort = string | null
export type SessionServiceTier = CodexServiceTier | null
export type SessionEffort = string | null

export { AgentStateSchema, AttachmentMetadataSchema, MachineMetadataSchema, MetadataSchema }

export type MachineMetadata = ProtocolMachineMetadata

export const RunnerStateSchema = z.object({
    status: z.union([z.enum(['running', 'shutting-down']), z.string()]),
    pid: z.number().optional(),
    httpPort: z.number().optional(),
    startedAt: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.union([z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']), z.string()]).optional(),
    lastSpawnError: z.object({
        message: z.string(),
        pid: z.number().optional(),
        exitCode: z.number().nullable().optional(),
        signal: z.string().nullable().optional(),
        at: z.number()
    }).nullable().optional()
})

export type RunnerState = z.infer<typeof RunnerStateSchema>

export type Machine = {
    id: string
    namespace: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: MachineMetadata | null
    metadataVersion: number
    runnerState: RunnerState | null
    runnerStateVersion: number
}

export const CliMessagesResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        localId: z.string().nullable().optional(),
        content: z.unknown()
    }))
})

export type CliMessagesResponse = z.infer<typeof CliMessagesResponseSchema>

export const CreateSessionResponseSchema = z.object({
    session: z.object({
        id: z.string(),
        namespace: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        active: z.boolean(),
        activeAt: z.number(),
        metadata: z.unknown().nullable(),
        metadataVersion: z.number(),
        agentState: z.unknown().nullable(),
        agentStateVersion: z.number(),
        thinking: z.boolean(),
        thinkingAt: z.number(),
        todos: TodosSchema.optional(),
        model: z.string().nullable().optional().default(null),
        modelReasoningEffort: z.string().nullable().optional().default(null),
        serviceTier: CodexServiceTierSchema.nullable().optional().default(null),
        effort: z.string().nullable().optional().default(null),
        permissionMode: PermissionModeSchema.optional(),
        collaborationMode: CodexCollaborationModeSchema.optional()
    })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const CreateMachineResponseSchema = z.object({
    machine: z.object({
        id: z.string(),
        namespace: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        active: z.boolean(),
        activeAt: z.number(),
        metadata: z.unknown().nullable(),
        metadataVersion: z.number(),
        runnerState: z.unknown().nullable(),
        runnerStateVersion: z.number()
    })
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional(),
    messageKind: z.enum([
        'background_notification',
        'internal_tool_result',
        'internal_sidechain',
        'internal_meta',
        'internal_plan_restart',
        'internal_command_name',
        'internal_local_command_caveat',
        'internal_system_reminder'
    ]).optional()
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
    content: z.union([
        z.object({
            type: z.literal('output'),
            data: z.unknown()
        }),
        z.object({
            type: z.literal(AGENT_MESSAGE_PAYLOAD_TYPE),
            data: z.unknown()
        })
    ]),
    meta: MessageMetaSchema.optional()
})

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

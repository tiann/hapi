import {
    AgentStateSchema,
    AttachmentMetadataSchema,
    MetadataSchema,
    ModelModeSchema,
    PermissionModeSchema,
    TodosSchema
} from '@hapi/protocol/schemas'
import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
import { z } from 'zod'
import { UsageSchema } from '@/claude/types'

export type Usage = z.infer<typeof UsageSchema>

export type {
    AgentState,
    AttachmentMetadata,
    ClaudePermissionMode,
    CodexPermissionMode,
    Metadata,
    Session
} from '@hapi/protocol/types'
export type SessionPermissionMode = PermissionMode
export type SessionModelMode = ModelMode

export { AgentStateSchema, AttachmentMetadataSchema, MetadataSchema }

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    displayName: z.string().optional(),
    homeDir: z.string(),
    happyHomeDir: z.string(),
    happyLibDir: z.string()
})

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const RunnerStateSchema = z.object({
    status: z.union([z.enum(['running', 'shutting-down']), z.string()]),
    pid: z.number().optional(),
    httpPort: z.number().optional(),
    startedAt: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.union([z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']), z.string()]).optional()
})

export type RunnerState = z.infer<typeof RunnerStateSchema>

export type Machine = {
    id: string
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
        sortOrder: z.string().nullable(),
        metadata: z.unknown().nullable(),
        metadataVersion: z.number(),
        agentState: z.unknown().nullable(),
        agentStateVersion: z.number(),
        thinking: z.boolean(),
        thinkingAt: z.number(),
        todos: TodosSchema.optional(),
        permissionMode: PermissionModeSchema.optional(),
        modelMode: ModelModeSchema.optional()
    })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

const MachineRecordSchema = z.object({
    id: z.string(),
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

export const CreateMachineResponseSchema = z.object({
    machine: MachineRecordSchema
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const CliMachinesResponseSchema = z.object({
    machines: z.array(MachineRecordSchema)
})

export type CliMachinesResponse = z.infer<typeof CliMachinesResponseSchema>

export const CliSpawnSessionResponseSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('success'),
        sessionId: z.string(),
        initialPromptDelivery: z.enum(['delivered', 'timed_out']).optional()
    }),
    z.object({
        type: z.literal('error'),
        message: z.string()
    })
])

export type CliSpawnSessionResponse = z.infer<typeof CliSpawnSessionResponseSchema>

export const CliRestartSessionsResponseSchema = z.object({
    results: z.array(z.object({
        sessionId: z.string(),
        name: z.string().nullable(),
        status: z.enum(['restarted', 'skipped', 'failed']),
        error: z.string().optional()
    }))
})

export type CliRestartSessionsResponse = z.infer<typeof CliRestartSessionsResponseSchema>

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
